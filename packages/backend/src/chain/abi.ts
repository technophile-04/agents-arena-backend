import { parseAbi, parseAbiItem } from 'viem';

export const FLAG_MINTED_SOLIDITY_SIGNATURE =
  'event FlagMinted(address indexed minter, uint256 indexed tokenId, uint256 indexed challengeId);';

export const flagMintedEvent = parseAbiItem(
  'event FlagMinted(address indexed minter, uint256 indexed tokenId, uint256 indexed challengeId)',
);

export const nftFlagsAbi = parseAbi([
  'event FlagMinted(address indexed minter, uint256 indexed tokenId, uint256 indexed challengeId)',
  'function mint(address recipient, uint256 challengeId)',
  'function hasMinted(address recipient, uint256 challengeId) view returns (bool)',
]);

export const challenge1Abi = parseAbi([
  'event AgentInit(address indexed agent, uint256 agentId)',
  'function registerAgent(uint256 agentId)',
  'function registered(address agent) view returns (bool)',
]);

export const identityRegistryAbi = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);
