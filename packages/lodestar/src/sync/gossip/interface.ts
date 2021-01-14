export enum GossipStatus {
  STARTED,
  STOPPED,
}

export type IGossipHandler = {
  status: GossipStatus;
  start(): Promise<void>;
  stop(): void;
  handleSyncCompleted(): void;
};
