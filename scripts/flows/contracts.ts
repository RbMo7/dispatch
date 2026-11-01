/** Test contracts the flows deploy on Base Sepolia, compiled with `solc` at prepare time. */

export const FLOW_TOKEN_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FlowToken {
    string public constant name = "Flows Test Token";
    string public constant symbol = "FLOW";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() {
        totalSupply = 1000000 * 10 ** 6;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
`;

export const FLOW_VAULT_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FlowVault {
    event Deposited(address indexed from, uint256 amount, string note);

    function deposit(string calldata note) external payable {
        require(msg.value > 0, "no value");
        emit Deposited(msg.sender, msg.value, note);
    }

    function revertAlways() external pure {
        require(false, "always reverts");
    }
}
`;

export const FLOW_VAULT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [{ name: 'note', type: 'string' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revertAlways',
    stateMutability: 'pure',
    inputs: [],
    outputs: [],
  },
] as const;

/** Multicall3's `aggregate3Value`, callable only by its deployer, as Bulk Call's ERC-20 items need. */
export const FLOW_AGGREGATOR_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FlowAggregator {
    struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }
    struct Result { bool success; bytes returnData; }

    address public immutable owner;

    constructor() { owner = msg.sender; }

    function aggregate3Value(Call3Value[] calldata calls) external payable returns (Result[] memory returnData) {
        require(msg.sender == owner, "not owner");
        uint256 valueTotal;
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            Call3Value calldata c = calls[i];
            valueTotal += c.value;
            (bool success, bytes memory ret) = c.target.call{value: c.value}(c.callData);
            require(success || c.allowFailure, "call failed");
            returnData[i] = Result(success, ret);
        }
        require(msg.value == valueTotal, "value mismatch");
    }
}
`;
