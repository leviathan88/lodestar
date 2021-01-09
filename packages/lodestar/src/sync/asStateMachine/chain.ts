import PeerId from "peer-id";
import {BeaconBlocksByRangeRequest, Epoch, SignedBeaconBlock} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {itTrigger} from "../../util/it-trigger";
import {TimeSeries} from "../stats/timeSeries";
import {Batch, BatchMetadata, BatchStatus} from "./batch";
import {shuffle, sortBy, BlockProcessorError} from "./utils";

/**
 * Should return if ALL blocks are processed successfully
 * If SOME blocks are processed must throw BlockProcessorError()
 */
type ProcessChainSegment = (blocks: SignedBeaconBlock[]) => Promise<void>;

type DownloadBeaconBlocksByRange = (peer: PeerId, request: BeaconBlocksByRangeRequest) => Promise<SignedBeaconBlock[]>;

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

type FinalizedCheckpointPeerSet = {
  peers: PeerId[];
  targetEpoch: Epoch;
};

export class InitialSyncAsStateMachine {
  /** The start of the chain segment. Any epoch previous to this one has been validated. */
  validatedEpoch: Epoch;
  /** Batches validated by this chain. */
  validatedBatches = 0;
  /** A multi-threaded, non-blocking processor for applying messages to the beacon chain. */
  private processChainSegment: ProcessChainSegment;
  private downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange;
  /** Puhasble object to guarantee that processChainSegment is run only at once at anytime */
  private batchProcessor = itTrigger();
  /** Sorted map of batches undergoing some kind of processing. */
  private batches: Map<Epoch, Batch> = new Map();
  /** Dynamic targetEpoch with associated peers. May be `null`ed if no suitable peer set exists */
  private peerSet: FinalizedCheckpointPeerSet | null = null;
  private timeSeries = new TimeSeries({maxPoints: 1000});
  private logger: ILogger;
  private config: IBeaconConfig;

  constructor(
    localFinalizedEpoch: Epoch,
    processChainSegment: ProcessChainSegment,
    downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange,
    config: IBeaconConfig,
    logger: ILogger
  ) {
    this.processChainSegment = processChainSegment;
    this.downloadBeaconBlocksByRange = downloadBeaconBlocksByRange;
    this.config = config;
    this.logger = logger;

    // Get the *aligned* epoch that produces a batch containing the `localFinalizedEpoch`
    this.validatedEpoch =
      localFinalizedEpoch +
      Math.floor((localFinalizedEpoch - localFinalizedEpoch) / EPOCHS_PER_BATCH) * EPOCHS_PER_BATCH;
  }

  /**
   * The SyncManager should dynamically inject pools of peers and their targetEpoch through this method.
   * It may inject `null` if the peer pool does not meet some condition like peers < minPeers, which
   * would temporarily pause the sync once all active requests are done.
   */
  peerSetChanged(peerSet: FinalizedCheckpointPeerSet | null): void {
    this.peerSet = peerSet;
    this.triggerBatchDownloader();
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
    this.triggerBatchProcessor();
    this.triggerBatchDownloader();

    // Start processing batches on demand in strict sequence
    for await (const _ of this.batchProcessor) {
      await this.processCompletedBatches();
    }
  }

  stopSyncing(): void {
    this.batchProcessor.end();
    this.timeSeries.clear();
  }

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
    if (this.peerSet) this.requestBatches(this.peerSet);
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
      const failedPeers = batch.getFailedPeers();
      const [peer] = sortBy(
        peers,
        (peer) => (failedPeers.includes(peer) ? 1 : 0),
        (peer) => activeRequestsByPeer.get(peer) ?? 0
      );
      if (peer) {
        this.sendBatch(batch, peer);
      }
    }

    // find the next pending batch and request it from the peer. Shuffle peers for load balancing
    const idlePeers = shuffle(peers.filter((peer) => !activeRequestsByPeer.get(peer)));
    for (const peer of idlePeers) {
      const batch = this.includeNextBatch(targetEpoch);
      if (!batch) {
        break;
      }
      this.sendBatch(batch, peer);
    }
  }

  private getActiveRequestsByPeer(): WeakMap<PeerId, number> {
    const activeRequestsByPeer = new WeakMap<PeerId, number>();
    for (const batch of this.batches.values()) {
      if (batch.state.status === BatchStatus.Downloading) {
        activeRequestsByPeer.set(batch.state.peer, (activeRequestsByPeer.get(batch.state.peer) ?? 0) + 1);
      }
    }
    return activeRequestsByPeer;
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
  private sendBatch(batch: Batch, peer: PeerId): void {
    // Inform the batch about the new request
    this.logger.info("Downloading batch", batch.getMetadata());
    batch.startDownloading(peer);

    this.downloadBeaconBlocksByRange(peer, batch.request)
      .then((blocks) => {
        // TODO: verify that blocks are in range
        // TODO: verify that blocks are sequential

        this.logger.info("Downloaded batch", batch.getMetadata());
        batch.downloadingSuccess(blocks || []);

        // Pre-emptively request more blocks from peers whilst we process current blocks
        this.triggerBatchDownloader();
        this.triggerBatchProcessor();
      })
      .catch((error) => {
        // Register the download error and check if the batch can be retried
        this.logger.error("Downloaded batch error", batch.getMetadata(), error);
        batch.downloadingError();

        this.triggerBatchDownloader();
      });
  }

  //
  // Processor methods
  //

  /**
   * Processes the next ready batch if any
   */
  private async processCompletedBatches(): Promise<void> {
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
          return;
      }
    }

    // TODO: Validate that the current batches status make sense, to hopefully recover from dead ends
    // i.e. If all states are in AwaitingValidation status, `this.batches.clear()`
    this.logger.error("Error: all batches are in AwaitingValidation state, should not happen");
  }

  /**
   * Sends to process the batch
   */
  private async processBatch(batch: Batch): Promise<void> {
    try {
      this.logger.info("Processing batch", batch.getMetadata());
      const blocks = batch.startProcessing();

      // Okay to process empty batches since they can be validated by next batches
      await this.processChainSegment(blocks);

      this.logger.info("Processed batch", batch.getMetadata());
      this.onProcessedBatchSuccess(batch, blocks);
    } catch (error) {
      this.logger.error("Process batch error", batch.getMetadata(), error);

      // Handle this invalid batch, that is within the re-process retries limit.
      this.onProcessedBatchError(batch, error);
    }
  }

  private onProcessedBatchSuccess(batch: Batch, blocks: SignedBeaconBlock[]): void {
    batch.processingSuccess();

    // If the processed batch was not empty, we can validate previous unvalidated blocks.
    if (blocks.length > 0) {
      this.advanceChain(batch.startEpoch);
    }

    // Check if the chain has completed syncing
    const lastFinalizedEpochBatch = batch.startEpoch + EPOCHS_PER_BATCH - 1;
    if (this.peerSet && lastFinalizedEpochBatch >= this.peerSet.targetEpoch) {
      this.batchProcessor.end();
      this.logger.important("Completed initial sync", {targetEpoch: this.peerSet.targetEpoch});
    } else {
      this.logSyncProgress(lastFinalizedEpochBatch);
      this.triggerBatchDownloader();
      this.triggerBatchProcessor();
    }
  }

  /**
   * An invalid batch has been received that could not be processed, but that can be retried.
   */
  private onProcessedBatchError(batch: Batch, error: Error): void {
    batch.processingError();

    // At least one block was successfully verified and imported, so we can be sure all
    // previous batches are valid and we only need to download the current failed batch.
    if (error instanceof BlockProcessorError && error.importedBlocks.length > 0) {
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

    this.triggerBatchDownloader();
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
  private logSyncProgress(lastFinalizedEpoch: Epoch): void {
    this.timeSeries.addPoint(lastFinalizedEpoch);

    const targetEpoch = this.peerSet?.targetEpoch;
    if (!targetEpoch) return;

    const epochsPerSecond = this.timeSeries.computeLinearSpeed();
    const slotsPerSecond = epochsPerSecond * this.config.params.SLOTS_PER_EPOCH;
    const hoursToGo = (targetEpoch - lastFinalizedEpoch) / (slotsPerSecond * 3600);
    this.logger.info(`Sync progress ${lastFinalizedEpoch}/${targetEpoch}`, {
      slotsPerSecond: slotsPerSecond.toPrecision(3),
      hoursLeft: hoursToGo.toPrecision(3),
    });
  }
}
