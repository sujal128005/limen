// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ISupplierRegistry {
    function recordSettlement(address supplier, uint128 volume, bool onTime) external;
    function recordDispute(address supplier) external;
    function isRegistered(address wallet) external view returns (bool);
}

/// @title ProcurementEscrow
/// @notice Stablecoin escrow for agent-negotiated procurement, with an on-chain
///         spending policy that bounds what an autonomous agent is allowed to commit.
///
/// @dev Three properties do real work here and are the reason this is on-chain at all:
///
///      1. SEPARATION OF AUTHORITY. The buyer and the agent are different addresses.
///         The buyer alone can write a policy. The agent alone can spend under it.
///         An agent holding its own key cannot widen its own mandate, because
///         setAgentPolicy keys off msg.sender - the buyer - and there is no path
///         from createDeal to policy mutation. This is the difference between
///         "we promise the agent won't overspend" and "the agent cannot".
///
///      2. AGENT SPENDING POLICY. The buyer publishes limits (per-deal cap, cumulative
///         cap, expiry) as contract state. Any deal the agent opens is checked against
///         those limits by the EVM. A buggy, jailbroken or hallucinating agent cannot
///         exceed them, because the ceiling is not enforced in the agent's own code -
///         it is enforced by a contract the agent cannot edit.
///
///      3. SETTLEMENT-BOUND REPUTATION. Reputation is written by this contract, and only
///         on real fund movement. It cannot be purchased, self-reported, or reset by
///         moving to a different marketplace.
contract ProcurementEscrow {
    enum State { None, Funded, Delivered, Released, Refunded, Disputed }

    struct Policy {
        address agent;        // the ONLY address permitted to spend under this policy
        uint128 maxPerDeal;   // hard ceiling for any single commitment
        uint128 maxTotal;     // cumulative ceiling across the policy's life
        uint128 spent;        // cumulative committed to date
        uint64  expiry;       // policy auto-expires; agent authority is never open-ended
        bool    active;
    }

    struct Deal {
        address buyer;
        address supplier;
        uint128 amount;
        uint64  deliveryDeadline;
        uint64  createdAt;
        uint64  deliveredAt;
        bytes32 termsHash;    // keccak256 of the exact agreed terms
        State   state;
    }

    IERC20 public immutable token;
    ISupplierRegistry public immutable registry;

    uint256 public dealCount;
    mapping(uint256 => Deal) public deals;
    mapping(address => Policy) public policies;

    event PolicySet(address indexed buyer, address indexed agent, uint128 maxPerDeal, uint128 maxTotal, uint64 expiry);
    event PolicyRevoked(address indexed buyer);
    event DealCreated(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed supplier,
        uint128 amount,
        uint64 deliveryDeadline,
        bytes32 termsHash
    );
    event DeliveryConfirmed(uint256 indexed dealId, uint64 confirmedAt, bool onTime);
    event PaymentReleased(uint256 indexed dealId, address indexed supplier, uint128 amount, bool onTime);
    event DealRefunded(uint256 indexed dealId, address indexed buyer, uint128 amount);
    event DealDisputed(uint256 indexed dealId, address indexed raisedBy);

    error PolicyInactive();
    error PolicyExpired();
    error ExceedsPerDealCap(uint128 requested, uint128 cap);
    error ExceedsTotalCap(uint128 requested, uint128 remaining);
    error SupplierNotRegistered();
    error BadState(State found);
    error NotBuyer();
    error NotAuthorisedAgent(address caller, address expected);
    error NotParty();
    error ZeroAmount();
    error DeadlineInPast();
    error Reentrancy();

    uint256 private _locked = 1;
    modifier lock() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _token, address _registry) {
        token = IERC20(_token);
        registry = ISupplierRegistry(_registry);
    }

    // ---------------------------------------------------------------------
    // Agent spending policy
    // ---------------------------------------------------------------------

    /// @notice Buyer authorises a specific agent address to commit funds, within hard bounds.
    /// @dev Keyed on msg.sender, so a policy can only ever be written by the buyer it
    ///      belongs to. The agent has no route to this function for its own policy -
    ///      calling it would simply create a separate, empty policy owned by the agent.
    function setAgentPolicy(address agent, uint128 maxPerDeal, uint128 maxTotal, uint64 expiry) external {
        require(agent != address(0), "policy: zero agent");
        require(maxPerDeal > 0 && maxTotal >= maxPerDeal, "policy: bad caps");
        require(expiry > block.timestamp, "policy: expiry in past");
        Policy storage p = policies[msg.sender];
        p.agent = agent;
        p.maxPerDeal = maxPerDeal;
        p.maxTotal = maxTotal;
        p.expiry = expiry;
        p.active = true;
        emit PolicySet(msg.sender, agent, maxPerDeal, maxTotal, expiry);
    }

    function revokeAgentPolicy() external {
        policies[msg.sender].active = false;
        emit PolicyRevoked(msg.sender);
    }

    function remainingAllowance(address buyer) external view returns (uint128) {
        Policy memory p = policies[buyer];
        if (!p.active || p.expiry <= block.timestamp) return 0;
        return p.maxTotal > p.spent ? p.maxTotal - p.spent : 0;
    }

    // ---------------------------------------------------------------------
    // Deal lifecycle
    // ---------------------------------------------------------------------

    /// @notice Open a funded escrow for an agreed deal. Enforces the buyer's policy.
    /// @dev Funds move from the buyer to this contract here - the supplier cannot
    ///      touch them until delivery is confirmed.
    /// @param buyer The account whose policy and funds this deal draws on.
    /// @dev Called by the AGENT, not the buyer. The agent proves nothing except that
    ///      it is the address the buyer nominated; every limit is re-checked here.
    function createDeal(
        address buyer,
        address supplier,
        uint128 amount,
        uint64 deliveryDeadline,
        bytes32 termsHash
    ) external lock returns (uint256 dealId) {
        if (amount == 0) revert ZeroAmount();
        if (deliveryDeadline <= block.timestamp) revert DeadlineInPast();
        if (!registry.isRegistered(supplier)) revert SupplierNotRegistered();

        Policy storage p = policies[buyer];
        if (!p.active) revert PolicyInactive();
        if (msg.sender != p.agent) revert NotAuthorisedAgent(msg.sender, p.agent);
        if (p.expiry <= block.timestamp) revert PolicyExpired();
        if (amount > p.maxPerDeal) revert ExceedsPerDealCap(amount, p.maxPerDeal);
        uint128 remaining = p.maxTotal > p.spent ? p.maxTotal - p.spent : 0;
        if (amount > remaining) revert ExceedsTotalCap(amount, remaining);

        p.spent += amount;

        dealId = ++dealCount;
        deals[dealId] = Deal({
            buyer: buyer,
            supplier: supplier,
            amount: amount,
            deliveryDeadline: deliveryDeadline,
            createdAt: uint64(block.timestamp),
            deliveredAt: 0,
            termsHash: termsHash,
            state: State.Funded
        });

        require(token.transferFrom(buyer, address(this), amount), "escrow: funding failed");
        emit DealCreated(dealId, buyer, supplier, amount, deliveryDeadline, termsHash);
    }

    /// @notice Buyer confirms goods were received.
    /// @dev MVP: the buyer attests. Production would additionally accept an attestation
    ///      from a logistics oracle or a nominated inspector - see README.
    function confirmDelivery(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.state != State.Funded) revert BadState(d.state);
        if (msg.sender != d.buyer) revert NotBuyer();
        d.state = State.Delivered;
        d.deliveredAt = uint64(block.timestamp);
        emit DeliveryConfirmed(dealId, d.deliveredAt, d.deliveredAt <= d.deliveryDeadline);
    }

    /// @notice Release escrowed funds to the supplier and write reputation.
    function releasePayment(uint256 dealId) external lock {
        Deal storage d = deals[dealId];
        if (d.state != State.Delivered) revert BadState(d.state);
        if (msg.sender != d.buyer && msg.sender != d.supplier) revert NotParty();

        bool onTime = d.deliveredAt <= d.deliveryDeadline;
        d.state = State.Released;

        require(token.transfer(d.supplier, d.amount), "escrow: release failed");
        registry.recordSettlement(d.supplier, d.amount, onTime);

        emit PaymentReleased(dealId, d.supplier, d.amount, onTime);
    }

    /// @notice Buyer reclaims funds if the supplier missed the deadline without delivering.
    function refundExpired(uint256 dealId) external lock {
        Deal storage d = deals[dealId];
        if (d.state != State.Funded) revert BadState(d.state);
        if (msg.sender != d.buyer) revert NotBuyer();
        require(block.timestamp > d.deliveryDeadline, "escrow: not yet expired");

        d.state = State.Refunded;
        Policy storage p = policies[d.buyer];
        p.spent = p.spent > d.amount ? p.spent - d.amount : 0; // restore headroom

        require(token.transfer(d.buyer, d.amount), "escrow: refund failed");
        registry.recordDispute(d.supplier);

        emit DealRefunded(dealId, d.buyer, d.amount);
    }

    function raiseDispute(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.state != State.Funded && d.state != State.Delivered) revert BadState(d.state);
        if (msg.sender != d.buyer && msg.sender != d.supplier) revert NotParty();
        d.state = State.Disputed;
        emit DealDisputed(dealId, msg.sender);
    }

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }
}
