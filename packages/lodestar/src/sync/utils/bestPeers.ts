import PeerId from "peer-id";
import {Checkpoint, Root, Slot, Status} from "@chainsafe/lodestar-types";
import {getSyncProtocols, INetwork} from "../../network";
import {toHexString} from "@chainsafe/ssz";

interface IPeerWithMetadata {
  peerId: PeerId;
  status: Status;
  score: number;
}

function getPeersThatSupportSync(network: INetwork): IPeerWithMetadata[] {
  const peers: IPeerWithMetadata[] = [];

  for (const libp2pPeer of network.getPeers({supportsProtocols: getSyncProtocols()})) {
    const peerId = libp2pPeer.id;
    const status = network.peerMetadata.getStatus(peerId);
    const score = network.peerRpcScores.getScore(peerId);
    if (status) {
      peers.push({peerId, status, score});
    }
  }

  return peers;
}

/**
 * Get peers that:
 * - support sync protocols
 * - their score > minScore
 * - status = most common finalied checkpoint
 */
export function getPeersInitialSync(network: INetwork, minScore = 60): IPeersByCheckpoint<Checkpoint> | null {
  const peers = getPeersThatSupportSync(network);
  const goodPeers = peers.filter((peer) => peer.score > minScore);
  return getPeersByMostCommonFinalizedCheckpoint(goodPeers);
}

/**
 * Get peers that:
 * - support sync protocols
 * - their headSlot > ourHeadSlot
 * - their score > minScore
 * - status = highest known head.slot
 */
export function getPeersRegularSync(network: INetwork, ourHeadSlot: Slot, minScore = 60): IPeersByHead {
  const peers = getPeersThatSupportSync(network);
  const goodHeadPeers = peers.filter((peer) => peer.status.headSlot > ourHeadSlot && peer.score > minScore);
  return getPeersByHighestHead(goodHeadPeers);
}

export function isGoodPeerRegularSync(peerId: PeerId, network: INetwork, ourHeadSlot: Slot, minScore = 60): boolean {
  const status = network.peerMetadata.getStatus(peerId);
  const score = network.peerRpcScores.getScore(peerId);
  return status !== null && status.headSlot > ourHeadSlot && score > minScore;
}

/**
 * Return a sorted list (from best to worst) of peers to sync from
 */
export function getGoodPeersToSyncFrom(network: INetwork, ourHeadSlot: Slot, minScore = 60): PeerId[] {
  return network
    .getPeers({supportsProtocols: getSyncProtocols()})
    .map((libp2pPeer) => libp2pPeer.id)
    .filter((peer) => network.peerRpcScores.getScore(peer) > minScore)
    .filter((peer) => {
      const status = network.peerMetadata.getStatus(peer);
      return !!status && status.headSlot > ourHeadSlot;
    })
    .sort((p1, p2) => network.peerRpcScores.getScore(p2) - network.peerRpcScores.getScore(p1));
}

/**
 * For initial sync, return the most common finalized checkpoint and consider it as the truth
 * If is important to have minimum amount of peers connected so the chance of connecting
 * only to malicious peers is low.
 *
 * Returns both the most common finalized checkpoint and the group or peers who agree on it
 */
export function getPeersByMostCommonFinalizedCheckpoint(
  peers: IPeerWithMetadata[]
): IPeersByCheckpoint<Checkpoint> | null {
  const peersByCheckpoint = groupPeersByCheckpoint(
    peers,
    (peer) => ({epoch: peer.status.finalizedEpoch, root: peer.status.finalizedRoot}),
    (checkpoint) => checkpoint.epoch.toString() + toHexString(checkpoint.root)
  );

  const sortedByMostCommon = peersByCheckpoint.sort((a, b) => {
    if (a.peers.length > b.peers.length) return -1;
    if (a.peers.length < b.peers.length) return 1;
    if (a.checkpoint.epoch > b.checkpoint.epoch) return -1;
    if (a.checkpoint.epoch < b.checkpoint.epoch) return 1;
    return 0;
  });

  const mostCommon = sortedByMostCommon[0];
  if (!mostCommon) return null;

  return {
    checkpoint: mostCommon.checkpoint,
    peers: mostCommon.peers.sort((a, b) => b.score - a.score),
  };
}

type IPeersByHead = IPeersByCheckpoint<{slot: Slot; root: Root}>;

/**
 * For regular sync, return peers that claim to have the highest head.slot and group all peers
 * that agree with that specific head.slot and head.root.
 * If multiple peers are found, they are ordered by score from highest to lowest
 */
export function getPeersByHighestHead(peers: IPeerWithMetadata[]): IPeersByHead {
  const peersByCheckpoint = groupPeersByCheckpoint(
    peers,
    (peer) => ({slot: peer.status.headSlot, root: peer.status.headRoot}),
    (checkpoint) => checkpoint.slot.toString(10) + toHexString(checkpoint.root)
  );

  const sortedByHighestHead = peersByCheckpoint.sort((a, b) => {
    if (a.checkpoint.slot > b.checkpoint.slot) return -1;
    if (a.checkpoint.slot < b.checkpoint.slot) return 1;
    if (a.peers.length > b.peers.length) return -1;
    if (a.peers.length < b.peers.length) return 1;
    return 0;
  });

  const highestHead = sortedByHighestHead[0];
  if (!highestHead) throw Error("No peers found");

  return {
    checkpoint: highestHead.checkpoint,
    peers: highestHead.peers.sort((a, b) => b.score - a.score),
  };
}

interface IPeersByCheckpoint<T> {
  checkpoint: T;
  peers: IPeerWithMetadata[];
}

/**
 * Groups peers by checkpoint as defined by `getCheckpointFromPeer` and `getCheckpointId`
 */
function groupPeersByCheckpoint<T>(
  peers: IPeerWithMetadata[],
  getCheckpointFromPeer: (peer: IPeerWithMetadata) => T,
  getCheckpointId: (checkpoint: T) => string
): IPeersByCheckpoint<T>[] {
  const peersByCheckpoint = new Map<string, IPeersByCheckpoint<T>>();

  for (const peer of peers) {
    const checkpoint = getCheckpointFromPeer(peer);
    const id = getCheckpointId(checkpoint);
    let checkpointPeers = peersByCheckpoint.get(id);
    if (checkpointPeers) {
      checkpointPeers.peers.push(peer);
    } else {
      checkpointPeers = {checkpoint, peers: [peer]};
    }
    peersByCheckpoint.set(id, checkpointPeers);
  }

  return Array.from(peersByCheckpoint.values());
}
