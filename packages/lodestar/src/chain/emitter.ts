import {EventEmitter} from "events";
import StrictEventEmitter from "strict-event-emitter-types";

import {phase0, Epoch, Slot, Version} from "@chainsafe/lodestar-types";
import {IBlockSummary} from "@chainsafe/lodestar-fork-choice";
import {IForkName} from "@chainsafe/lodestar-config";
import {IBlockJob, ITreeStateContext} from "./interface";
import {AttestationError, BlockError} from "./errors";

/**
 * Important chain events that occur during normal chain operation.
 *
 * Chain events can be broken into several categories:
 * - Clock: the chain's clock is updated
 * - Fork Choice: the chain's fork choice is updated
 * - Processing: the chain processes attestations and blocks, either successfully or with an error
 * - Checkpointing: the chain processes epoch boundaries
 */
export enum ChainEvent {
  /**
   * This event signals that the chain has successfully processed a valid attestation.
   *
   * This event is guaranteed to be emitted after every attestation fed to the chain has successfully been passed to the fork choice.
   */
  attestation = "attestation",
  /**
   * This event signals that the chain has successfully processed a valid block.
   *
   * This event is guaranteed to be emitted after every block fed to the chain has successfully passed the state transition.
   */
  block = "block",
  /**
   * This event signals that the chain has processed (or reprocessed) a checkpoint.
   *
   * This event is not tied to clock events, but rather tied to generation (or regeneration) of state.
   * This event is guaranteed to be called after _any_ checkpoint is processed, including skip-slot checkpoints, checkpoints that are formed as a result of processing blocks, etc.
   */
  checkpoint = "checkpoint",
  /**
   * This event signals that the chain has processed (or reprocessed) a checkpoint state with an updated justified checkpoint.
   *
   * This event is a derivative of the `checkpoint` event. Eg: in cases where the `checkpoint` stateContext has an updated justified checkpoint, this event is triggered.
   */
  justified = "justified",
  /**
   * This event signals that the chain has processed (or reprocessed) a checkpoint state with an updated finalized checkpoint.
   *
   * This event is a derivative of the `checkpoint` event. Eg: in cases where the `checkpoint` stateContext has an updated finalized checkpoint, this event is triggered.
   */
  finalized = "finalized",
  /**
   * This event signals that the chain has reached a new fork version.
   *
   * This event is guaranteed to be triggered after processing any block or checkpoint that updates the `state.fork.currentVersion` as a result of processing.
   */
  forkVersion = "forkVersion",
  /**
   * This event signals the start of a new slot, and that subsequent calls to `clock.currentSlot` will equal `slot`.
   *
   * This event is guaranteed to be emitted every `SECONDS_PER_SLOT` seconds.
   */
  clockSlot = "clock:slot",
  /**
   * This event signals the start of a new epoch, and that subsequent calls to `clock.currentEpoch` will return `epoch`.
   *
   * This event is guaranteed to be emitted every `SECONDS_PER_SLOT * SLOTS_PER_EPOCH` seconds.
   */
  clockEpoch = "clock:epoch",
  /**
   * This event signals that the fork choice has been updated to a new head.
   *
   * This event is guaranteed to be emitted after every sucessfully processed block, if that block updates the head.
   */
  forkChoiceHead = "forkChoice:head",
  /**
   * This event signals that the fork choice has been updated to a new head that is not a descendant of the previous head.
   *
   * This event is guaranteed to be emitted after every sucessfully processed block, if that block results results in a reorg.
   */
  forkChoiceReorg = "forkChoice:reorg",
  /**
   * This event signals that the fork choice store has been updated.
   *
   * This event is guaranteed to be triggered whenever the fork choice justified checkpoint is updated. This is either in response to a newly processed block or a new clock tick.
   */
  forkChoiceJustified = "forkChoice:justified",
  /**
   * This event signals that the fork choice store has been updated.
   *
   * This event is guaranteed to be triggered whenever the fork choice justified checkpoint is updated. This is in response to a newly processed block.
   */
  forkChoiceFinalized = "forkChoice:finalized",
  /**
   * This event signals that the chain has errored while processing an attestation.
   *
   * This event is guaranteed to be triggered after any attestation fed to the chain fails at any stage of processing.
   */
  errorAttestation = "error:attestation",
  /**
   * This event signals that the chain has errored while processing a block.
   *
   * This event is guaranteed to be triggered after any block fed to the chain fails at any stage of processing.
   */
  errorBlock = "error:block",
}

export interface IChainEvents {
  [ChainEvent.attestation]: (attestation: phase0.Attestation) => void;
  [ChainEvent.block]: (
    signedBlock: phase0.SignedBeaconBlock,
    postStateContext: ITreeStateContext,
    job: IBlockJob
  ) => void;
  [ChainEvent.errorAttestation]: (error: AttestationError) => void;
  [ChainEvent.errorBlock]: (error: BlockError) => void;

  [ChainEvent.checkpoint]: (checkpoint: phase0.Checkpoint, stateContext: ITreeStateContext) => void;
  [ChainEvent.justified]: (checkpoint: phase0.Checkpoint, stateContext: ITreeStateContext) => void;
  [ChainEvent.finalized]: (checkpoint: phase0.Checkpoint, stateContext: ITreeStateContext) => void;
  [ChainEvent.forkVersion]: (version: Version, fork: IForkName) => void;

  [ChainEvent.clockSlot]: (slot: Slot) => void;
  [ChainEvent.clockEpoch]: (epoch: Epoch) => void;

  [ChainEvent.forkChoiceHead]: (head: IBlockSummary) => void;
  [ChainEvent.forkChoiceReorg]: (head: IBlockSummary, oldHead: IBlockSummary, depth: number) => void;
  [ChainEvent.forkChoiceJustified]: (checkpoint: phase0.Checkpoint) => void;
  [ChainEvent.forkChoiceFinalized]: (checkpoint: phase0.Checkpoint) => void;
}

/**
 * Emits important chain events that occur during normal chain operation.
 *
 * Chain events can be broken into several categories:
 * - Clock: the chain's clock is updated
 * - Fork Choice: the chain's fork choice is updated
 * - Processing: the chain processes attestations and blocks, either successfully or with an error
 * - Checkpointing: the chain processes epoch boundaries
 */
export class ChainEventEmitter extends (EventEmitter as {new (): StrictEventEmitter<EventEmitter, IChainEvents>}) {}
