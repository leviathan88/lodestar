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
import {Network} from "../../../../../../src/network/network";
import {BeaconSync} from "../../../../../../src/sync/sync";

use(chaiAsPromised);

describe("api - beacon - getBlockHeader", function () {
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
    const result = await blockApi.getBlockHeader("1");
    expect(result).to.be.null;
  });

  it("invalid block id", async function () {
    resolveBlockIdStub.withArgs(config, sinon.match.any, sinon.match.any, "abc").throwsException();
    await expect(blockApi.getBlockHeader("abc")).to.eventually.be.rejected;
  });

  it("success for block", async function () {
    resolveBlockIdStub.withArgs(config, sinon.match.any, sinon.match.any, "head").resolves(generateEmptySignedBlock());
    const result = await blockApi.getBlockHeader("head");
    expect(result).to.not.be.null;
    expect(() => config.types.phase0.SignedBeaconHeaderResponse.assertValidValue(result)).to.not.throw();
  });
});
