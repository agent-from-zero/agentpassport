// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @dev The v1 escrow's JobEscrow ABI subset this test needs (v1 has no accept / acceptedAt).
interface IJobEscrowV1 {
    function open(IJobEscrow.OpenParams calldata p) external returns (uint256 jobId);
    function refund(uint256 jobId) external;
}

/// @dev Finding F-1 of docs/SECURITY.md reproduced against the *deployed* contracts on a Monad testnet
///      fork: with the live v1 JobEscrow anyone can put a refund mark on any agent's passport by
///      opening a job the agent never saw (cost: gas, and 0.000001 USDC that comes back). The same
///      attack through JobEscrow v2, attesting into the same live AgentPassport, leaves no mark.
contract ForkFindingsTest is Test {
    IAgentPassport internal constant PASSPORT = IAgentPassport(0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A);
    IJobEscrowV1 internal constant ESCROW_V1 = IJobEscrowV1(0x5b197edD258572DEe7C923A6D38D6Db268A266BC);
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    address internal constant USDC_HOLDER = 0x0ec686e8c3FAE59DD0892a7c691752Cf7b98fFBa; // our hirer wallet
    uint256 internal constant AGENTFROMZERO = 1908;
    /// @dev After job #5 settled (passport 1908 = 4 settled / 1 refunded) and before v2 existed.
    uint256 internal constant PINNED_BLOCK = 65_010_953;

    address internal griefer = makeAddr("griefer");

    function setUp() public {
        if (bytes(vm.envOr("SKIP_FORK_TESTS", string(""))).length != 0) return;
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")), PINNED_BLOCK);
        vm.prank(USDC_HOLDER);
        IERC20(USDC).transfer(griefer, 10);
    }

    modifier onFork() {
        if (bytes(vm.envOr("SKIP_FORK_TESTS", string(""))).length != 0) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _unsolicited() internal view returns (IJobEscrow.OpenParams memory p) {
        p = IJobEscrow.OpenParams({
            agentId: AGENTFROMZERO,
            token: USDC,
            amount: 1,
            deadline: uint64(block.timestamp + 1),
            reviewWindow: 0,
            verifier: address(0),
            specHash: bytes32(0),
            endpoint: "grief"
        });
    }

    function test_fork_F1_v1_unsolicitedJobMarksPassport() public onFork {
        IAgentPassport.Passport memory before = PASSPORT.passportOf(AGENTFROMZERO);
        assertEq(before.jobsRefunded, 1);

        vm.startPrank(griefer);
        IERC20(USDC).approve(address(ESCROW_V1), 1);
        uint256 jobId = ESCROW_V1.open(_unsolicited());
        vm.warp(block.timestamp + 2);
        ESCROW_V1.refund(jobId);
        vm.stopPrank();

        assertEq(PASSPORT.passportOf(AGENTFROMZERO).jobsRefunded, before.jobsRefunded + 1, "v1: mark written");
        assertEq(IERC20(USDC).balanceOf(griefer), 10, "and the griefer got its money back");
    }

    function test_fork_F1_v2_unsolicitedJobLeavesNoMark() public onFork {
        // Deploy v2 against the live passport and allow it, as script/DeployEscrowV2.s.sol does.
        JobEscrow v2 = new JobEscrow(IDENTITY, address(PASSPORT), USDC);
        vm.prank(AgentPassportOwner.get(PASSPORT));
        (bool ok,) = address(PASSPORT).call(abi.encodeWithSignature("setAttester(address,bool)", address(v2), true));
        assertTrue(ok && PASSPORT.isAttester(address(v2)));
        IAgentPassport.Passport memory before = PASSPORT.passportOf(AGENTFROMZERO);

        vm.startPrank(griefer);
        IERC20(USDC).approve(address(v2), 1);
        uint256 jobId = v2.open(_unsolicited());
        vm.warp(block.timestamp + 2);
        v2.refund(jobId);
        vm.stopPrank();

        IAgentPassport.Passport memory afterP = PASSPORT.passportOf(AGENTFROMZERO);
        assertEq(afterP.jobsRefunded, before.jobsRefunded, "v2: no mark");
        assertEq(afterP.jobsSettled, before.jobsSettled);
        assertEq(IERC20(USDC).balanceOf(griefer), 10);
    }
}

library AgentPassportOwner {
    function get(IAgentPassport p) internal view returns (address o) {
        (, bytes memory ret) = address(p).staticcall(abi.encodeWithSignature("owner()"));
        o = abi.decode(ret, (address));
    }
}
