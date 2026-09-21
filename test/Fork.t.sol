// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {AgentPassport} from "../src/AgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";
import {IIdentityRegistry, IReputationRegistry} from "../src/interfaces/IERC8004.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @dev Fork tests against Monad testnet (chain id 10143): the canonical ERC-8004 registries and
///      Circle USDC as actually deployed. Pinned to a block so results are reproducible.
///
///      RPC: `MONAD_TESTNET_RPC` env var, defaulting to the public QuickNode endpoint (no key).
///      Set `SKIP_FORK_TESTS=1` to skip offline.
contract ForkTest is BaseTest {
    // Canonical Monad testnet addresses (docs.monad.xyz + erc-8004/erc-8004-contracts README).
    IIdentityRegistry internal constant ID = IIdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IReputationRegistry internal constant REP = IReputationRegistry(0x8004B663056A597Dffe9eCcC1965A193B7388713);
    address internal constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    /// @dev Our hirer wallet after its Circle-faucet drip (20 USDC at block ~64,400,270). Used as
    ///      the USDC source on the fork so no key material is needed in tests.
    address internal constant USDC_HOLDER = 0x0ec686e8c3FAE59DD0892a7c691752Cf7b98fFBa;
    uint256 internal constant PINNED_BLOCK = 64_401_500;

    AgentPassport internal fPassport;
    JobEscrow internal fEscrow;
    uint256 internal fAgentId;

    function setUp() public override {
        if (bytes(vm.envOr("SKIP_FORK_TESTS", string(""))).length != 0) return;
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")), PINNED_BLOCK);
        assertEq(block.chainid, 10143, "not Monad testnet");

        fPassport = new AgentPassport(address(ID), address(REP));
        fEscrow = new JobEscrow(address(ID), address(fPassport), USDC);
        fPassport.setAttester(address(fEscrow), true);

        // Register a fresh agent through the real registry: the owner is `agentOwner`, and the
        // registry sets agentWallet = msg.sender on register (v2.0.0 behaviour).
        vm.prank(agentOwner);
        fAgentId = ID.register("https://agentfromzero.netlify.app/.well-known/agent-card.json");
        assertEq(ID.ownerOf(fAgentId), agentOwner);
        assertEq(ID.getAgentWallet(fAgentId), agentOwner);

        // Fund the hirer with real (testnet) USDC from our faucet-funded wallet.
        vm.prank(USDC_HOLDER);
        IERC20(USDC).transfer(hirer, 10_000_000);
        vm.prank(hirer);
        IERC20(USDC).approve(address(fEscrow), type(uint256).max);
    }

    modifier onFork() {
        if (bytes(vm.envOr("SKIP_FORK_TESTS", string(""))).length != 0) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _fParams() internal view returns (IJobEscrow.OpenParams memory p) {
        p = _params();
        p.agentId = fAgentId;
        p.token = USDC;
    }

    /// @dev Confirms the exact `giveFeedback` ABI on the live ReputationRegistry, that the passport
    ///      contract is accepted as a client (it is neither owner nor operator of the agent), and
    ///      that the written entry is readable back with our tags.
    function test_fork_giveFeedback_realRegistry() public onFork {
        fPassport.setAttester(address(this), true);
        bytes32 jobRef = keccak256("job-ref");

        vm.expectEmit(true, true, false, true, address(fPassport));
        emit IAgentPassport.FeedbackMirrored(fAgentId, jobRef, true);
        fPassport.attest(fAgentId, jobRef, IAgentPassport.Outcome.Settled, USDC, 5_000_000, hirer, "summarise");

        assertEq(REP.getLastIndex(fAgentId, address(fPassport)), 1);
        (int128 value, uint8 dec, string memory tag1, string memory tag2, bool revoked) =
            REP.readFeedback(fAgentId, address(fPassport), 1);
        assertEq(value, 100);
        assertEq(dec, 2);
        assertEq(tag1, "agentpassport");
        assertEq(tag2, "settled");
        assertFalse(revoked);
        address[] memory clients = REP.getClients(fAgentId);
        assertEq(clients.length, 1);
        assertEq(clients[0], address(fPassport));
    }

    /// @dev The registry refuses feedback from the agent's owner ("Self-feedback not allowed").
    ///      This is why AgentPassport, not the escrow's users, is the feedback client.
    function test_fork_selfFeedbackRejectedByRegistry() public onFork {
        vm.prank(agentOwner);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        REP.giveFeedback(fAgentId, 100, 2, "agentpassport", "settled", "x", "", bytes32(0));
    }

    /// @dev Full lifecycle against real registries + real USDC: open -> deliver (agentWallet) ->
    ///      release -> USDC paid to the registry's agentWallet, passport updated, feedback mirrored.
    function test_fork_lifecycle_realUsdcAndRegistries() public onFork {
        vm.prank(hirer);
        uint256 jobId = fEscrow.open(_fParams());
        assertEq(IERC20(USDC).balanceOf(address(fEscrow)), PRICE);

        vm.prank(agentOwner); // == agentWallet on the real registry
        fEscrow.deliver(jobId, keccak256("deliverable"), "https://agentfromzero.netlify.app/d/1.json");

        vm.prank(hirer);
        fEscrow.release(jobId);

        assertEq(IERC20(USDC).balanceOf(agentOwner), PRICE);
        assertEq(IERC20(USDC).balanceOf(address(fEscrow)), 0);
        IAgentPassport.Passport memory pp = fPassport.passportOf(fAgentId);
        assertEq(pp.jobsSettled, 1);
        assertEq(pp.volumeSettled, PRICE);
        assertEq(pp.token, USDC);
        assertEq(REP.getLastIndex(fAgentId, address(fPassport)), 1);
    }

    /// @dev `openWithAuthorization` against Circle's FiatToken: the hirer signs an EIP-3009
    ///      ReceiveWithAuthorization (nonce = openNonce) and the agent relays it, paying the gas.
    function test_openWithAuthorization_fork() public onFork {
        uint256 gaslessKey = 0x6a51e55;
        address gaslessHirer = vm.addr(gaslessKey);
        vm.prank(USDC_HOLDER);
        IERC20(USDC).transfer(gaslessHirer, PRICE);
        assertEq(gaslessHirer.balance, 0, "hirer holds no MON");

        IJobEscrow.OpenParams memory p = _fParams();
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = fEscrow.openNonce(p, validAfter, validBefore);
        bytes memory sig = _signReceiveAuth(USDC, gaslessKey, address(fEscrow), PRICE, validAfter, validBefore, nonce);
        IJobEscrow.Authorization memory auth = IJobEscrow.Authorization({
            from: gaslessHirer, validAfter: validAfter, validBefore: validBefore, nonce: nonce, signature: sig
        });

        vm.prank(agentOwner);
        uint256 jobId = fEscrow.openWithAuthorization(p, auth);

        assertEq(IERC20(USDC).balanceOf(gaslessHirer), 0);
        assertEq(IERC20(USDC).balanceOf(address(fEscrow)), PRICE);
        assertEq(fEscrow.getJob(jobId).hirer, gaslessHirer);

        // Replaying the same authorization is refused by the token itself.
        vm.prank(USDC_HOLDER);
        IERC20(USDC).transfer(gaslessHirer, PRICE);
        vm.prank(agentOwner);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        fEscrow.openWithAuthorization(p, auth);
    }

    /// @dev A signature for job A cannot be spent on job B (nonce binding), even with real USDC.
    function test_openWithAuthorization_fork_rejectsRedirect() public onFork {
        uint256 gaslessKey = 0x6a51e55;
        address gaslessHirer = vm.addr(gaslessKey);
        vm.prank(USDC_HOLDER);
        IERC20(USDC).transfer(gaslessHirer, PRICE);

        IJobEscrow.OpenParams memory signedFor = _fParams();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = fEscrow.openNonce(signedFor, 0, validBefore);
        bytes memory sig = _signReceiveAuth(USDC, gaslessKey, address(fEscrow), PRICE, 0, validBefore, nonce);
        IJobEscrow.Authorization memory auth = IJobEscrow.Authorization({
            from: gaslessHirer, validAfter: 0, validBefore: validBefore, nonce: nonce, signature: sig
        });

        IJobEscrow.OpenParams memory redirected = signedFor;
        redirected.agentId = 1; // some other agent on the live registry
        bytes32 expected = fEscrow.openNonce(redirected, 0, validBefore);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.AuthorizationMismatch.selector, expected, nonce));
        fEscrow.openWithAuthorization(redirected, auth);
    }
}
