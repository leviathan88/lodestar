import {BeaconBlockApi} from "../../../../../../src/api/impl/beacon/blocks";
import * as blockUtils from "../../../../../../src/api/impl/beacon/blocks/utils";
import sinon, {SinonStub, SinonStubbedInstance} from "sinon";
import {BeaconChain, IBeaconChain} from "../../../../../../src/chain";
import {ForkChoice} from "@chainsafe/lodestar-fork-choice";
import {config} from "@chainsafe/lodestar-config/minimal";
import {StubbedBeaconDb} from "../../../../../utils/stub";
import {expect, use} from "chai";
import chaiAsPromised from "chai-as-promised";
import {generateEmptySignedBlock} from "../../../../../utils/block";
import {BeaconSync} from "../../../../../../src/sync/sync";
import {Network} from "../../../../../../src/network";

use(chaiAsPromised);

describe("api - beacon - getBlock", function () {
  const sandbox = sinon.createSandbox();

  let blockApi: BeaconBlockApi;
  let chainStub: SinonStubbedInstance<IBeaconChain>;
  let dbStub: StubbedBeaconDb;
  let forkChoiceStub: SinonStubbedInstance<ForkChoice>;
  let resolveBlockIdStub: SinonStub;

  beforeEach(function () {
    forkChoiceStub = sinon.createStubInstance(ForkChoice);
    chainStub = sinon.createStubInstance(BeaconChain);
    chainStub.forkChoice = forkChoiceStub;
    dbStub = new StubbedBeaconDb(sinon, config);
    resolveBlockIdStub = sandbox.stub(blockUtils, "resolveBlockId");
    blockApi = new BeaconBlockApi(
      {},
      {
        chain: chainStub,
        config,
        db: dbStub,
        network: sinon.createStubInstance(Network),
        sync: sinon.createStubInstance(BeaconSync),
      }
    );
  });

  afterEach(function () {
    sandbox.restore();
  });

  it("block not found", async function () {
    resolveBlockIdStub.withArgs(config, sinon.match.any, sinon.match.any, "1").resolves(null);
    const result = await blockApi.getBlock("1");
    expect(result).to.be.null;
  });

  it("invalid block id", async function () {
    resolveBlockIdStub.withArgs(config, sinon.match.any, sinon.match.any, "abc").throwsException();
    await expect(blockApi.getBlock("abc")).to.eventually.be.rejected;
  });

  it("success for non finalized block", async function () {
    resolveBlockIdStub.withArgs(config, sinon.match.any, sinon.match.any, "head").resolves(generateEmptySignedBlock());
    const result = await blockApi.getBlock("head");
    expect(result).to.not.be.null;
    expect(() => config.types.phase0.SignedBeaconBlock.assertValidValue(result)).to.not.throw();
  });

  it.skip("success for finalized block", async function () {
    resolveBlockIdStub.withArgs(config, sinon.match.any, sinon.match.any, "0").resolves(null);
    const result = await blockApi.getBlock("0");
    expect(result).to.not.be.null;
  });
});
