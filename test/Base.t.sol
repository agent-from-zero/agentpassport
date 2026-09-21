// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentPassport} from "../src/AgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";
import {MockUSDC, MockIdentityRegistry, MockReputationRegistry} from "../src/mocks/Mocks.sol";
import {P256} from "../src/libraries/P256.sol";
import {WebAuthn} from "../src/libraries/WebAuthn.sol";

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

    // ───────────── signing helpers (shared by unit + fork tests) ─────────────

    /// @dev EIP-3009 ReceiveWithAuthorization signature for `token` (FiatToken domain: name/version
    ///      read from the token, chainid, token address). `to` is always the escrow.
    function _signReceiveAuth(
        address token,
        uint256 signerKey,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory sig) {
        bytes32 domain = MockUSDC(token).DOMAIN_SEPARATOR(); // same selector on real FiatToken
        bytes32 structHash = keccak256(
            abi.encode(
                MockUSDC(token).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                vm.addr(signerKey),
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(signerKey, digest);
        sig = abi.encodePacked(r, s_, v);
    }

    /// @dev Builds a WebAuthn assertion over `challenge` with a P256 key, flags UP|UV, low-s.
    function _passkeyAssertion(uint256 p256Key, bytes32 challenge)
        internal
        pure
        returns (bytes memory authData, bytes memory clientDataJSON, uint256 r, uint256 s_)
    {
        authData = abi.encodePacked(sha256("agentfromzero.netlify.app"), uint8(0x05), uint32(1));
        clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            WebAuthn._base64Url(challenge),
            '","origin":"https://agentfromzero.netlify.app","crossOrigin":false}'
        );
        bytes32 msgHash = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
        (bytes32 rb, bytes32 sb) = vm.signP256(p256Key, msgHash);
        r = uint256(rb);
        s_ = uint256(sb) > P256.N_DIV_2 ? P256.N - uint256(sb) : uint256(sb);
    }
}
