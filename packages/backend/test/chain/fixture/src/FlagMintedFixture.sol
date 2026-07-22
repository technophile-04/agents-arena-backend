// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// Minimal fixture that emits the real FlagMinted event on every mint.
/// It does NOT guard against re-minting the same challenge, so tests can
/// drive the watcher's exactly-once projection with duplicate on-chain logs.
contract FlagMintedFixture {
    event FlagMinted(address indexed minter, uint256 indexed tokenId, uint256 indexed challengeId);

    uint256 public nextTokenId;

    function mint(address recipient, uint256 challengeId) external {
        uint256 tokenId = nextTokenId++;
        emit FlagMinted(recipient, tokenId, challengeId);
    }
}
