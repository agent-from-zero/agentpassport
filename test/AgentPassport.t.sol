// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";
import {AgentPassport} from "../src/AgentPassport.sol";

/// @dev Registry stand-in that always reverts (e.g. "Self-feedback not allowed").
contract RevertingRegistry {
    fallback() external {
        revert("nope");
    }
}

/// @dev Unit tests for the passport read model and attester gating.
contract AgentPassportTest is BaseTest {
    function test_attest_revertsForNonAttester() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentPassport.NotAttester.selector, stranger));
        passport.attest(agentId, bytes32(0), IAgentPassport.Outcome.Settled, address(usdc), 1, hirer, "x");
    }

    function test_setAttester_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AgentPassport.NotOwner.selector);
        passport.setAttester(stranger, true);
    }

    function test_attest_tokenMismatchReverts() public {
        passport.setAttester(address(this), true);
        passport.attest(agentId, keccak256("a"), IAgentPassport.Outcome.Settled, address(usdc), 1, hirer, "x");
        vm.expectRevert(abi.encodeWithSelector(IAgentPassport.TokenMismatch.selector, address(usdc), address(1)));
        passport.attest(agentId, keccak256("b"), IAgentPassport.Outcome.Settled, address(1), 1, hirer, "x");
    }

    function test_meets_policy() public {
        passport.setAttester(address(this), true);
        for (uint256 i = 0; i < 3; i++) {
            passport.attest(
                agentId, keccak256(abi.encode(i)), IAgentPassport.Outcome.Settled, address(usdc), 10e6, hirer, "x"
            );
        }
        IAgentPassport.Policy memory pol = IAgentPassport.Policy({
            minJobsSettled: 3, minVolumeSettled: 30e6, maxJobsDisputed: 0, maxAgeOfLastSettlement: 1 days
        });
        assertTrue(passport.meets(agentId, pol));

        pol.minJobsSettled = 4;
        assertFalse(passport.meets(agentId, pol));
        pol.minJobsSettled = 3;

        vm.warp(block.timestamp + 2 days);
        assertFalse(passport.meets(agentId, pol), "stale");
        pol.maxAgeOfLastSettlement = 0;
        assertTrue(passport.meets(agentId, pol));

        passport.attest(agentId, keccak256("d"), IAgentPassport.Outcome.Disputed, address(usdc), 0, hirer, "x");
        assertFalse(passport.meets(agentId, pol), "disputed");
    }

    function test_meets_unknownAgentIsFalse() public view {
        IAgentPassport.Policy memory pol = IAgentPassport.Policy({
            minJobsSettled: 1, minVolumeSettled: 0, maxJobsDisputed: 0, maxAgeOfLastSettlement: 0
        });
        assertFalse(passport.meets(424242, pol));
    }

    /// @dev Mirroring must never block settlement: a reverting registry only flips the event flag.
    function test_attest_survivesRegistryRevert() public {
        AgentPassport p2 = new AgentPassport(address(identity), address(new RevertingRegistry()));
        p2.setAttester(address(this), true);
        vm.expectEmit(true, true, false, true);
        emit IAgentPassport.FeedbackMirrored(agentId, keccak256("j"), false);
        p2.attest(agentId, keccak256("j"), IAgentPassport.Outcome.Settled, address(usdc), 1, hirer, "x");
        assertEq(p2.passportOf(agentId).jobsSettled, 1);
    }

    /// @dev Same guarantee when the registry address has no code (mis-configured deploy).
    function test_attest_survivesRegistryWithoutCode() public {
        AgentPassport p2 = new AgentPassport(address(identity), address(0xdead));
        p2.setAttester(address(this), true);
        vm.expectEmit(true, true, false, true);
        emit IAgentPassport.FeedbackMirrored(agentId, keccak256("j"), false);
        p2.attest(agentId, keccak256("j"), IAgentPassport.Outcome.Settled, address(usdc), 1, hirer, "x");
        assertEq(p2.passportOf(agentId).jobsSettled, 1);
    }
}
