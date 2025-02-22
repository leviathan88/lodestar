import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {IBeaconDb} from "../db";

export class Eth1DataCache {
  db: IBeaconDb;
  config: IBeaconConfig;

  constructor(config: IBeaconConfig, db: IBeaconDb) {
    this.config = config;
    this.db = db;
  }

  async get({timestampRange}: {timestampRange: {gte: number; lte: number}}): Promise<phase0.Eth1DataOrdered[]> {
    return await this.db.eth1Data.values(timestampRange);
  }

  async add(eth1Datas: (phase0.Eth1DataOrdered & {timestamp: number})[]): Promise<void> {
    await this.db.eth1Data.batchPutValues(eth1Datas);
  }

  async getHighestCachedBlockNumber(): Promise<number | null> {
    const highestEth1Data = await this.db.eth1Data.lastValue();
    return highestEth1Data && highestEth1Data.blockNumber;
  }
}
