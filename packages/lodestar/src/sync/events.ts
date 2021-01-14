import {EventEmitter} from "events";
import PeerId from "peer-id";
import StrictEventEmitter from "strict-event-emitter-types";

export enum SyncEvent {
  /** Peer connected with valid status */
  peerConnect = "peerConnect",
  /** Peer disconnected */
  peerDisconnect = "peerDisconnect",
}

export interface ISyncEvents {
  [SyncEvent.peerConnect]: (peer: PeerId) => void;
}

export class SyncEventBus extends (EventEmitter as {new (): StrictEventEmitter<EventEmitter, ISyncEvents>}) {}
