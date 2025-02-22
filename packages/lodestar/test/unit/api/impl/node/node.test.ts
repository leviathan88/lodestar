import {INodeApi} from "../../../../../src/api/impl/node";
import {NodeApi} from "../../../../../src/api/impl/node/node";
import sinon, {SinonStubbedInstance} from "sinon";
import {createPeerId, INetwork, Network} from "../../../../../src/network";
import {BeaconSync, IBeaconSync} from "../../../../../src/sync";
import {createKeypairFromPeerId, ENR} from "@chainsafe/discv5/lib";
import PeerId from "peer-id";
import {expect} from "chai";
import Multiaddr from "multiaddr";
import {MetadataController} from "../../../../../src/network/metadata";
import {phase0} from "@chainsafe/lodestar-types";
import {NodePeer} from "../../../../../src/api/types";
import {PeerStatus, PeerDirection} from "../../../../../src/network";

interface IPeerSummary {
  direction: string | null;
  state: string;
  hasPeerId: boolean;
  hasP2pAddress: boolean;
}

const toPeerSummary = (peer: NodePeer): IPeerSummary => {
  return {
    direction: peer.direction,
    state: peer.state,
    hasPeerId: !peer.peerId ? false : peer.peerId.length > 0,
    hasP2pAddress: !peer.lastSeenP2pAddress ? false : peer.lastSeenP2pAddress.length > 0,
  };
};

describe("node api implementation", function () {
  let api: INodeApi;
  let networkStub: SinonStubbedInstance<INetwork>;
  let syncStub: SinonStubbedInstance<IBeaconSync>;

  beforeEach(function () {
    networkStub = sinon.createStubInstance(Network);
    syncStub = sinon.createStubInstance(BeaconSync);
    api = new NodeApi({}, {network: networkStub, sync: syncStub});
  });

  describe("getNodeIdentity", function () {
    it("should get node identity", async function () {
      const peerId = await PeerId.create({keyType: "secp256k1"});
      const keypair = createKeypairFromPeerId(peerId);
      const enr = ENR.createV4(keypair.publicKey);
      enr.setLocationMultiaddr(new Multiaddr("/ip4/127.0.0.1/tcp/36001"));
      networkStub.getEnr.returns(enr);
      networkStub.peerId = peerId;
      networkStub.localMultiaddrs = [new Multiaddr("/ip4/127.0.0.1/tcp/36000")];
      networkStub.metadata = {
        get all(): phase0.Metadata {
          return {
            attnets: [true],
            seqNumber: BigInt(1),
          };
        },
      } as MetadataController;
      const identity = await api.getNodeIdentity();
      expect(identity.peerId.startsWith("16")).to.be.true;
      expect(identity.enr.startsWith("enr:-")).to.be.true;
      expect(identity.discoveryAddresses.length).to.equal(1);
      expect(identity.discoveryAddresses[0]).to.equal("/ip4/127.0.0.1/tcp/36001");
      expect(identity.p2pAddresses.length).to.equal(1);
      expect(identity.p2pAddresses[0]).to.equal("/ip4/127.0.0.1/tcp/36000");
      expect(identity.metadata).to.not.null;
    });

    it("should get node identity - no enr", async function () {
      const peerId = await PeerId.create({keyType: "secp256k1"});
      networkStub.getEnr.returns(null!);
      networkStub.peerId = peerId;
      networkStub.localMultiaddrs = [new Multiaddr("/ip4/127.0.0.1/tcp/36000")];
      const identity = await api.getNodeIdentity();
      expect(identity.enr).equal("");
    });
  });

  describe("getNodeStatus", function () {
    it("syncing", async function () {
      syncStub.isSynced.returns(false);
      const status = await api.getNodeStatus();
      expect(status).to.equal("syncing");
    });

    it("ready", async function () {
      syncStub.isSynced.resolves(true);
      const status = await api.getNodeStatus();
      expect(status).to.equal("ready");
    });
  });

  describe("getPeers", function () {
    it("should return connected and disconnecting peers", async function () {
      const peer1 = await createPeerId();
      const peer2 = await createPeerId();
      const connectionsByPeer = new Map<string, LibP2pConnection[]>([
        [peer1.toB58String(), [libp2pConnection(peer1, "open", "outbound")]],
        [peer2.toB58String(), [libp2pConnection(peer2, "closing", "inbound")]],
      ]);
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peers = await api.getPeers();
      expect(peers.length).to.equal(2);
      expect(peers.map(toPeerSummary)).to.be.deep.equal([
        {direction: "outbound", state: "connected", hasP2pAddress: true, hasPeerId: true},
        {direction: "inbound", state: "disconnecting", hasPeerId: true, hasP2pAddress: true},
      ]);
    });

    it("should return disconnected peers", async function () {
      const peer1 = await createPeerId();
      const peer2 = await createPeerId();
      const connectionsByPeer = new Map<string, LibP2pConnection[]>([
        [peer1.toB58String(), [libp2pConnection(peer1, "closed", "outbound")]],
        [peer2.toB58String(), []], // peer2 has no connections in the connection manager
      ]);
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peers = await api.getPeers();
      // expect(peers[0].enr).not.empty;
      expect(peers.map(toPeerSummary)).to.be.deep.equal([
        {direction: "outbound", state: "disconnected", hasPeerId: true, hasP2pAddress: true},
        {direction: null, state: "disconnected", hasPeerId: true, hasP2pAddress: false},
      ]);
    });
  });

  describe("getPeer", function () {
    it("success", async function () {
      const peer1 = await createPeerId();
      const peer2 = await createPeerId();
      const connectionsByPeer = new Map<string, LibP2pConnection[]>([
        [peer1.toB58String(), [libp2pConnection(peer1, "open", "outbound")]],
        [peer2.toB58String(), [libp2pConnection(peer2, "closing", "inbound")]],
      ]);
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peer = await api.getPeer(peer1.toB58String());
      if (!peer) throw Error("getPeer returned no peer");
      expect(peer.peerId).to.equal(peer1.toB58String());
      expect(peer.lastSeenP2pAddress).not.empty;
      expect(peer.peerId).not.empty;
      // expect(peers[0].enr).not.empty;
      expect(peer.direction).to.equal("outbound");
      expect(peer.state).to.equal("connected");
    });

    it("peer not found", async function () {
      const connectionsByPeer = new Map<string, LibP2pConnection[]>();
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peer = await api.getPeer("not existent");
      expect(peer).to.be.null;
    });
  });

  describe("getSyncStatus", function () {
    it("success", async function () {
      syncStub.getSyncStatus.resolves({
        headSlot: BigInt(2),
        syncDistance: BigInt(1),
      });
      const syncStatus = await api.getSyncingStatus();
      expect(syncStatus.headSlot.toString()).to.equal("2");
      expect(syncStatus.syncDistance.toString()).to.equal("1");
    });
  });

  describe("getVersion", function () {
    it("success", async function () {
      const version = await api.getVersion();
      expect(version.startsWith("Lodestar")).to.be.true;
    });
  });
});

export function libp2pConnection(peer: PeerId, status: PeerStatus, direction: PeerDirection): LibP2pConnection {
  return {
    remoteAddr: new Multiaddr(),
    stat: {
      status,
      direction,
    },
    remotePeer: peer,
  } as LibP2pConnection;
}
