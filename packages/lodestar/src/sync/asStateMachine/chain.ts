import PeerId from "peer-id";
import {BeaconBlocksByRangeRequest, Epoch, SignedBeaconBlock} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {itTrigger} from "../../util/it-trigger";
import {TimeSeries} from "../stats/timeSeries";
import {Batch, BatchMetadata, BatchStatus} from "./batch";
import {shuffle, sortBy} from "./utils";
import {BlockProcessorError} from "../../chain/errors";
import {SyncEventBus, SyncEvent} from "../events";

/**
 * Should return if ALL blocks are processed successfully
 * If SOME blocks are processed must throw BlockProcessorError()
 */
export type ProcessChainSegment = (blocks: SignedBeaconBlock[]) => Promise<void>;

export type DownloadBeaconBlocksByRange = (
  peer: PeerId,
  request: BeaconBlocksByRangeRequest
) => Promise<SignedBeaconBlock[]>;

/**
 * The SyncManager should dynamically inject pools of peers and their targetEpoch through this method.
 * It may inject `null` if the peer pool does not meet some condition like peers < minPeers, which
 * would temporarily pause the sync once all active requests are done.
 */
export type GetPeerSet = () => FinalizedCheckpointPeerSet | null;

type FinalizedCheckpointPeerSet = {
  peers: PeerId[];
  targetEpoch: Epoch;
};

/**
 * Blocks are downloaded in batches from peers. This constant specifies how many epochs worth of
 * blocks per batch are requested _at most_. A batch may request less blocks to account for
 * already requested slots. There is a timeout for each batch request. If this value is too high,
 * we will negatively report peers with poor bandwidth. This can be set arbitrarily high, in which
 * case the responder will fill the response up to the max request size, assuming they have the
 * bandwidth to do so.
 */
const EPOCHS_PER_BATCH = 2;

/**
 * The maximum number of batches to queue before requesting more.
 */
const BATCH_BUFFER_SIZE = 5;

export class InitialSyncAsStateMachine {
  /** The start of the chain segment. Any epoch previous to this one has been validated. */
  validatedEpoch: Epoch;
  /** Batches validated by this chain. */
  validatedBatches = 0;
  /** A multi-threaded, non-blocking processor for applying messages to the beacon chain. */
  private processChainSegment: ProcessChainSegment;
  private downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange;
  private getPeerSet: GetPeerSet;
  /** Puhasble object to guarantee that processChainSegment is run only at once at anytime */
  private batchProcessor = itTrigger();
  /** Sorted map of batches undergoing some kind of processing. */
  private batches: Map<Epoch, Batch> = new Map();
  private peerIdString: WeakMap<PeerId, string> = new WeakMap();

  private syncEventBus: SyncEventBus;

  /** Dynamic targetEpoch with associated peers. May be `null`ed if no suitable peer set exists */
  private peerSet: FinalizedCheckpointPeerSet | null = null;
  private timeSeries = new TimeSeries({maxPoints: 1000});
  private logger: ILogger;
  private config: IBeaconConfig;

  constructor(
    localFinalizedEpoch: Epoch,
    processChainSegment: ProcessChainSegment,
    downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange,
    getPeerSet: GetPeerSet,
    syncEventBus: SyncEventBus,
    config: IBeaconConfig,
    logger: ILogger
  ) {
    this.processChainSegment = processChainSegment;
    this.downloadBeaconBlocksByRange = downloadBeaconBlocksByRange;
    this.getPeerSet = getPeerSet;
    this.syncEventBus = syncEventBus;
    this.config = config;
    this.logger = logger;

    // Get the *aligned* epoch that produces a batch containing the `localFinalizedEpoch`
    this.validatedEpoch =
      localFinalizedEpoch +
      Math.floor((localFinalizedEpoch - localFinalizedEpoch) / EPOCHS_PER_BATCH) * EPOCHS_PER_BATCH;
  }

  /**
   * For debugging and inspect the current status of active batches
   */
  batchesStatus(): BatchMetadata[] {
    return Array.from(this.batches.values()).map((batch) => batch.getMetadata());
  }

  /**
   * Main Promise that handles the sync process. Will resolve when initial sync completes
   * i.e. when it successfully processes a epoch >= than this chain `targetEpoch`
   */
  async startSyncing(): Promise<void> {
    this.syncEventBus.on(SyncEvent.peerConnect, this.onPeerConnect);

    this.triggerBatchProcessor();
    this.triggerBatchDownloader();

    // Start processing batches on demand in strict sequence
    for await (const _ of this.batchProcessor) {
      const result = await this.processCompletedBatches();
      switch (result) {
        case ProcessorAction.ProcessNext:
          this.triggerBatchProcessor();
          break;
        case ProcessorAction.Done:
          return;
        case ProcessorAction.NoProcessingReady:
          // When here, there must be at least one batch available to reach sendBatch() success so
          // it can trigger the processor again
          break;
      }
    }
  }

  stopSyncing(): void {
    this.syncEventBus.off(SyncEvent.peerConnect, this.onPeerConnect);

    this.batchProcessor.end();
    this.timeSeries.clear();
  }

  onPeerConnect = (): void => {
    this.triggerBatchDownloader();
  };

  /**
   * Request to process batches if any
   */
  private triggerBatchProcessor(): void {
    this.batchProcessor.trigger();
  }

  /**
   * Request to download batches if any
   * Backlogs requests into a single pending request
   */
  private triggerBatchDownloader(): void {
    const peerSet = this.getPeerSet();
    if (peerSet) this.requestBatches(peerSet);
  }

  //
  // Downloader methods
  //

  /**
   * Attempts to request the next required batches from the peer pool if the chain is syncing.
   * It will exhaust the peer pool and left over batches until the batch buffer is reached.
   *
   * The peers that agree on the same finalized checkpoint and thus available to download
   * this chain from, as well as the batches we are currently requesting.
   */
  private requestBatches({peers, targetEpoch}: FinalizedCheckpointPeerSet): void {
    const activeRequestsByPeer = this.getActiveRequestsByPeer();

    // Retry download of existing batches
    for (const batch of this.batches.values()) {
      if (batch.state.status !== BatchStatus.AwaitingDownload) {
        continue;
      }

      // Sort peers by (1) no failed request (2) less active requests, then pick first
      const failedPeers = batch.getFailedPeers().map((peer) => this.getPeerIdString(peer));
      const [peer] = sortBy(
        peers,
        (peer) => (failedPeers.includes(this.getPeerIdString(peer)) ? 1 : 0),
        (peer) => activeRequestsByPeer.get(this.getPeerIdString(peer)) ?? 0
      );
      if (peer) {
        void this.sendBatch(batch, peer);
      }
    }

    // find the next pending batch and request it from the peer. Shuffle peers for load balancing
    const idlePeers = shuffle(peers.filter((peer) => !activeRequestsByPeer.get(this.getPeerIdString(peer))));
    for (const peer of idlePeers) {
      const batch = this.includeNextBatch(targetEpoch);
      if (!batch) {
        break;
      }
      void this.sendBatch(batch, peer);
    }
  }

  /**
   * Compute activeRequestsByPeer from this.batch internal states
   */
  private getActiveRequestsByPeer(): Map<string, number> {
    const activeRequestsByPeer = new Map<string, number>();
    for (const batch of this.batches.values()) {
      if (batch.state.status === BatchStatus.Downloading) {
        const peerIdString = this.getPeerIdString(batch.state.peer);
        activeRequestsByPeer.set(peerIdString, (activeRequestsByPeer.get(peerIdString) ?? 0) + 1);
      }
    }
    return activeRequestsByPeer;
  }

  /**
   * Caches peerId.toB58String result in a WeakMap
   */
  private getPeerIdString(peerId: PeerId): string {
    let peerIdString = this.peerIdString.get(peerId);
    if (!peerIdString) {
      peerIdString = peerId.toB58String();
      this.peerIdString.set(peerId, peerIdString);
    }
    return peerIdString;
  }

  /**
   * Creates the next required batch from the chain. If there are no more batches required,
   * `null` is returned.
   */
  private includeNextBatch(targetEpoch: Epoch): Batch | null {
    // Only request batches up to the buffer size limit
    // NOTE: we don't count batches in the AwaitingValidation state, to prevent stalling sync
    // if the current processing window is contained in a long range of skip slots.
    const batchesInBuffer = Array.from(this.batches.values()).filter(
      (batch) => batch.state.status === BatchStatus.Downloading || batch.state.status === BatchStatus.AwaitingProcessing
    );

    if (batchesInBuffer.length > BATCH_BUFFER_SIZE) {
      return null;
    }

    // This line decides the starting epoch of the next batch. MUST ensure no duplicate batch for the same startEpoch
    const epochsWithBatch = Array.from(this.batches.keys());
    const startEpoch =
      epochsWithBatch.length > 0 ? Math.max(...epochsWithBatch) + EPOCHS_PER_BATCH : this.validatedEpoch;

    // Don't request batches beyond the target head slot
    if (startEpoch > targetEpoch) {
      return null;
    }

    const batch = new Batch(startEpoch, EPOCHS_PER_BATCH, this.config, this.logger);
    this.batches.set(startEpoch, batch);
    return batch;
  }

  /**
   * Requests the batch asigned to the given id from a given peer.
   */
  private async sendBatch(batch: Batch, peer: PeerId): Promise<void> {
    // Inform the batch about the new request
    this.logger.info("Downloading batch", batch.getMetadata());
    batch.startDownloading(peer);

    try {
      const blocks = await this.downloadBeaconBlocksByRange(peer, batch.request);

      // TODO: verify that blocks are in range
      // TODO: verify that blocks are sequential

      this.logger.info("Downloaded batch", batch.getMetadata());
      batch.downloadingSuccess(blocks || []);

      this.triggerBatchProcessor();
    } catch (e) {
      // Register the download error and check if the batch can be retried
      this.logger.error("Downloaded batch error", batch.getMetadata(), e);
      batch.downloadingError();
    } finally {
      // Pre-emptively request more blocks from peers whilst we process current blocks
      this.triggerBatchDownloader();
    }
  }

  //
  // Processor methods
  //

  /**
   * Processes the next ready batch if any
   */
  private async processCompletedBatches(): Promise<ProcessorAction> {
    // ES6 Map MUST guarantee insertion order so older batches are processed first
    for (const batch of this.batches.values()) {
      switch (batch.state.status) {
        // If an AwaitingProcessing batch exists it can only be preceeded by AwaitingValidation
        case BatchStatus.AwaitingValidation:
          break;

        case BatchStatus.AwaitingProcessing:
          return await this.processBatch(batch);

        // There MUST be no AwaitingProcessing state after AwaitingDownload, Downloading, Processing
        case BatchStatus.AwaitingDownload:
        case BatchStatus.Downloading:
        case BatchStatus.Processing:
          return ProcessorAction.NoProcessingReady;
      }
    }

    // TODO: Validate that the current batches status make sense, to hopefully recover from dead ends
    // i.e. If all states are in AwaitingValidation status, `this.batches.clear()`
    this.logger.error("Error: all batches are in AwaitingValidation state, should not happen");

    return ProcessorAction.NoProcessingReady;
  }

  /**
   * Sends to process the batch
   */
  private async processBatch(batch: Batch): Promise<ProcessorAction> {
    try {
      this.logger.info("Processing batch", batch.getMetadata());
      const blocks = batch.startProcessing();

      // Okay to process empty batches since they can be validated by next batches
      await this.processChainSegment(blocks);

      this.logger.info("Processed batch", batch.getMetadata());
      return this.onProcessedBatchSuccess(batch, blocks);
    } catch (error) {
      // Handle this invalid batch, that is within the re-process retries limit.
      this.logger.error("Process batch error", batch.getMetadata(), error);
      return this.onProcessedBatchError(batch, error);
    }
  }

  private onProcessedBatchSuccess(batch: Batch, blocks: SignedBeaconBlock[]): ProcessorAction {
    batch.processingSuccess();

    // If the processed batch was not empty, we can validate previous unvalidated blocks.
    if (blocks.length > 0) {
      this.advanceChain(batch.startEpoch);
    }

    // Check if the chain has completed syncing
    const lastEpochBatch = batch.startEpoch + EPOCHS_PER_BATCH - 1;
    if (this.peerSet && lastEpochBatch >= this.peerSet.targetEpoch) {
      this.logger.important("Completed initial sync", {targetEpoch: this.peerSet.targetEpoch});
      return ProcessorAction.Done;
    } else {
      this.logSyncProgress(lastEpochBatch);
      // A batch is no longer in Processing status, queue has an empty spot to download next batch
      this.triggerBatchDownloader();
      return ProcessorAction.ProcessNext;
    }
  }

  /**
   * An invalid batch has been received that could not be processed, but that can be retried.
   */
  private onProcessedBatchError(batch: Batch, error: Error): ProcessorAction {
    batch.processingError();

    // At least one block was successfully verified and imported, so we can be sure all
    // previous batches are valid and we only need to download the current failed batch.
    if (error instanceof BlockProcessorError && error.importedJobs.length > 0) {
      this.advanceChain(batch.startEpoch);
    }

    // The current batch could not be processed, so either this or previous batches are invalid.
    // The current (sub-optimal) strategy is to simply re-request all batches that could
    // potentially be faulty.

    // All previous batches must be awaiting validation and are marked for retry
    // All non-validated progress will be destroyed up-to this.startEpoch
    for (const pendingBatch of this.batches.values()) {
      if (pendingBatch.startEpoch < batch.startEpoch) {
        pendingBatch.validationError();
      }
    }

    // Re-download failed batches
    this.triggerBatchDownloader();
    return ProcessorAction.NoProcessingReady;
  }

  /**
   * Removes any batches previous to `newValidatedEpoch` and updates the chain boundaries
   */
  private advanceChain(newValidatedEpoch: Epoch): void {
    // make sure this epoch produces an advancement
    if (newValidatedEpoch <= this.validatedEpoch) {
      return;
    }

    for (const [batchKey, batch] of this.batches.entries()) {
      if (batch.startEpoch < newValidatedEpoch) {
        this.batches.delete(batchKey);
        this.validatedBatches += 1;

        if (batch.state.status === BatchStatus.AwaitingValidation) {
          // TODO: do peer scoring with download attempts
        } else {
          this.logger.warn("Validated batch with inconsistent status", batch.getMetadata());
        }
      }
    }

    const prevValidatedEpoch = this.validatedEpoch;
    this.validatedEpoch = newValidatedEpoch;
    this.logger.info("Chain advanced", {prevValidatedEpoch, newValidatedEpoch});
  }

  /**
   * Register sync progress in TimeSeries instance and log current speed and time left
   */
  private logSyncProgress(epoch: Epoch): void {
    this.timeSeries.addPoint(epoch);

    const targetEpoch = this.peerSet?.targetEpoch;
    if (!targetEpoch) return;

    const epochsPerSecond = this.timeSeries.computeLinearSpeed();
    const slotsPerSecond = epochsPerSecond * this.config.params.SLOTS_PER_EPOCH;
    const hoursToGo = (targetEpoch - epoch) / (epochsPerSecond * 3600);
    this.logger.info(`Sync progress ${epoch}/${targetEpoch}`, {
      slotsPerSecond: slotsPerSecond.toPrecision(3),
      hoursLeft: hoursToGo.toPrecision(3),
    });
  }
}

enum ProcessorAction {
  NoProcessingReady,
  Done,
  ProcessNext,
}
