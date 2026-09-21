// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentPassport} from "../src/AgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";
import {MockUSDC, MockIdentityRegistry, MockReputationRegistry} from "../src/mocks/Mocks.sol";

/// @dev Shared fixture: mock ERC-8004 registries, mock USDC, one registered agent, one funded hirer.
abstract contract BaseTest is Test {
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockUSDC internal usdc;
    AgentPassport internal passport;
    JobEscrow internal escrow;

    address internal agentOwner = makeAddr("agentOwner"); // agentfromzero's ERC-8004 owner key
    address internal agentWallet = makeAddr("agentWallet"); // where the agent gets paid
    address internal hirer = makeAddr("hirer");
    address internal verifier = makeAddr("verifier");
    address internal stranger = makeAddr("stranger");

    uint256 internal agentId;
    uint128 internal constant PRICE = 5_000_000; // 5 USDC
    uint64 internal constant REVIEW = 1 hours;

    function setUp() public virtual {
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry(identity);
        usdc = new MockUSDC();
        passport = new AgentPassport(address(identity), address(reputation));
        escrow = new JobEscrow(address(identity), address(passport), address(usdc));
        passport.setAttester(address(escrow), true);

        vm.startPrank(agentOwner);
        agentId = identity.register("https://agentfromzero.netlify.app/agent-card.json");
        identity.setAgentWalletUnsafe(agentId, agentWallet);
        vm.stopPrank();

        usdc.mint(hirer, 1_000_000_000); // 1,000 USDC
        vm.prank(hirer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _params() internal view returns (IJobEscrow.OpenParams memory p) {
        p = IJobEscrow.OpenParams({
            agentId: agentId,
            token: address(usdc),
            amount: PRICE,
            deadline: uint64(block.timestamp + 1 days),
            reviewWindow: REVIEW,
            verifier: address(0),
            specHash: keccak256("spec: summarise https://example.com in 200 words"),
            endpoint: "summarise"
        });
    }

    function _openJob() internal returns (uint256 jobId) {
        vm.prank(hirer);
        jobId = escrow.open(_params());
    }

    function _deliver(uint256 jobId) internal {
        vm.prank(agentWallet);
        escrow.deliver(jobId, keccak256("deliverable"), "ipfs://deliverable");
    }
}
