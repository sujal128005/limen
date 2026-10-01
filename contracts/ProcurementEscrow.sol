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

    /// @notice The supplier's half of the authority model: a price it will not go below.
    ///
    /// @dev The mirror of Policy above, and the reason this contract is two-sided.
    ///
    ///      Note what the supplier does NOT have to do: sign the deal. The buyer's
    ///      agent is still the only caller of createDeal. The floor protects a
    ///      supplier against a transaction it is not party to, which is the whole
    ///      point - a seller cannot be talked below its own number even by an agent
    ///      it has no control over, because the number is not in anybody's agent.
    ///
    ///      The floor is per UNIT, not per deal. A minimum total would be
    ///      meaningless: it would refuse ten kilograms and a thousand on the same
    ///      terms. So createDeal takes the quantity and the comparison is made
    ///      against amount, which is what makes this enforceable rather than
    ///      decorative.
    struct SellerPolicy {
        uint128 minUnitPrice; // token units (6dp) per unit of quantity. The floor.
        uint128 maxPerDeal;   // largest single order, in quantity, this seller will take
        uint128 maxTotal;     // cumulative quantity it is willing to commit
        uint128 committed;    // cumulative quantity committed to date
        uint64  expiry;       // a floor is a standing offer, and standing offers expire
        bool    active;
    }

    struct Deal {
        address buyer;
        address supplier;
        uint128 amount;
        uint128 quantity;     // what the amount buys. Needed to make a unit floor checkable.
        uint64  deliveryDeadline;
        uint64  createdAt;
        uint64  shippedAt;    // set by the SUPPLIER, not the buyer
        uint64  deliveredAt;
        bytes32 termsHash;    // keccak256 of the exact agreed terms
        bytes32 shipmentHash; // supplier's evidence reference, opaque to this contract
        State   state;
    }

    IERC20 public immutable token;
    ISupplierRegistry public immutable registry;

    uint256 public dealCount;
    mapping(uint256 => Deal) public deals;
    mapping(address => Policy) public policies;
    mapping(address => SellerPolicy) public sellerPolicies;

    event PolicySet(address indexed buyer, address indexed agent, uint128 maxPerDeal, uint128 maxTotal, uint64 expiry);
    event PolicyRevoked(address indexed buyer);
    event SellerPolicySet(
        address indexed supplier,
        uint128 minUnitPrice,
        uint128 maxPerDeal,
        uint128 maxTotal,
        uint64 expiry
    );
    event SellerPolicyRevoked(address indexed supplier);
    event DealCreated(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed supplier,
        uint128 amount,
        uint128 quantity,
        uint64 deliveryDeadline,
        bytes32 termsHash
    );
    event ShipmentAttested(uint256 indexed dealId, address indexed supplier, uint64 shippedAt, bytes32 shipmentHash);
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
    error NotSupplier();
    error NotShipped();
    error AlreadyShipped();
    error NotAuthorisedAgent(address caller, address expected);
    error NotParty();
    error ZeroAmount();
    error DeadlineInPast();
    error Reentrancy();

    /*
     * The seller's side of the refusals. Each is the mirror of a buyer error
     * above, and they are separate error types rather than reused ones because
     * the two sides fail for opposite reasons: the buyer's agent spent too
     * much, the seller's floor was undercut. A demo that reported both as
     * "ExceedsPerDealCap" would hide the thing worth showing.
     */
    error ZeroQuantity();
    error BelowSellerFloor(uint128 offeredUnitPrice, uint128 minUnitPrice, uint128 quantity);
    error ExceedsSellerPerDealCap(uint128 requested, uint128 cap);
    error ExceedsSellerCapacity(uint128 requested, uint128 remaining);
    error SellerPolicyExpired();

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
    // Seller floor policy
    // ---------------------------------------------------------------------

    /// @notice Supplier publishes the price it will not go below, and how much it can take.
    ///
    /// @dev Keyed on msg.sender, exactly as setAgentPolicy is. That one line is
    ///      the whole security argument on this side: the floor belongs to the
    ///      address that wrote it, so a buyer's agent calling this function does
    ///      not lower a supplier's floor - it creates a separate, meaningless
    ///      policy owned by the agent. There is no path from createDeal to this
    ///      function, and no owner, operator or admin who can reach it either.
    ///      Nobody can move a supplier's number but the supplier.
    ///
    ///      The supplier's own selling agent is therefore in the same position
    ///      the buyer's agent is in: it can negotiate anywhere above the floor
    ///      and nowhere below it, and telling it to "accept twenty percent less"
    ///      does not change what the chain will accept.
    ///
    ///      `committed` is deliberately NOT reset here, the same way `spent` is
    ///      not reset by setAgentPolicy. Re-publishing is how a supplier changes
    ///      its terms, not how it forgets what it already sold. A supplier that
    ///      wants fresh capacity raises maxTotal.
    ///
    /// @param minUnitPrice Token units (6dp) per one unit of quantity. The floor.
    /// @param maxPerDeal   Largest single order, in units of quantity, it will take.
    /// @param maxTotal     Cumulative quantity it is willing to commit under this policy.
    /// @param expiry       A standing offer with no end date is not an offer, it is a trap.
    function setSellerPolicy(uint128 minUnitPrice, uint128 maxPerDeal, uint128 maxTotal, uint64 expiry) external {
        require(minUnitPrice > 0, "floor: zero price");
        require(maxPerDeal > 0 && maxTotal >= maxPerDeal, "floor: bad caps");
        require(expiry > block.timestamp, "floor: expiry in past");
        /*
         * Bounded so the floor arithmetic in createDeal cannot be made to
         * overflow by publishing absurd numbers. minUnitPrice * maxPerDeal is
         * the largest product the check can ever compute, and both factors are
         * capped at 2**64, so the product fits in uint128 and the comparison
         * against `amount` is exact rather than wrapped.
         */
        require(minUnitPrice <= type(uint64).max, "floor: price too large");
        require(maxPerDeal <= type(uint64).max, "floor: quantity too large");

        SellerPolicy storage s = sellerPolicies[msg.sender];
        s.minUnitPrice = minUnitPrice;
        s.maxPerDeal = maxPerDeal;
        s.maxTotal = maxTotal;
        s.expiry = expiry;
        s.active = true;
        emit SellerPolicySet(msg.sender, minUnitPrice, maxPerDeal, maxTotal, expiry);
    }

    /// @notice Supplier withdraws its floor.
    /// @dev Note what this means, because it is the honest reading: a supplier
    ///      with no active policy has NO floor enforced, and a deal at any price
    ///      will be accepted against it. The floor is opt-in. That is the right
    ///      default for a contract that already has suppliers trading under it,
    ///      but it is not a safe assumption to make silently, so it is stated
    ///      here, tested, and surfaced by remainingCapacity returning zero.
    function revokeSellerPolicy() external {
        sellerPolicies[msg.sender].active = false;
        emit SellerPolicyRevoked(msg.sender);
    }

    /// @notice Quantity this supplier can still commit under its current policy.
    /// @dev Zero means either "fully committed", "expired", or "no floor
    ///      published". A caller that needs to tell those apart reads
    ///      sellerPolicies directly; a caller that just wants to know whether to
    ///      offer this supplier a deal does not.
    function remainingCapacity(address supplier) external view returns (uint128) {
        SellerPolicy memory s = sellerPolicies[supplier];
        if (!s.active || s.expiry <= block.timestamp) return 0;
        return s.maxTotal > s.committed ? s.maxTotal - s.committed : 0;
    }

    /// @notice The floor, in token units per unit of quantity, or zero if none is enforced.
    function floorPrice(address supplier) external view returns (uint128) {
        SellerPolicy memory s = sellerPolicies[supplier];
        if (!s.active || s.expiry <= block.timestamp) return 0;
        return s.minUnitPrice;
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
    ///
    ///      BOTH SIDES ARE CHECKED IN THIS ONE TRANSACTION. That is the point of
    ///      the function and the reason the quantity is now a parameter. The
    ///      buyer's agent is bounded above by the buyer's ceiling and bounded
    ///      below by the supplier's floor, in the same call, by the same EVM, and
    ///      neither agent can reach the state that bounds it. A deal exists only
    ///      where the two authorities overlap; outside that band it is not
    ///      refused so much as unrepresentable.
    ///
    ///      `quantity` is required and must be positive. It is tempting to make
    ///      it optional for the sake of the callers that predate it, but a second
    ///      entry point without a quantity would be a hole straight through the
    ///      floor: a floor that can be avoided by calling a different overload is
    ///      not a floor. So there is exactly one way to open a deal, and it
    ///      carries the number the floor is checked against.
    ///
    ///      Quantity is a whole number of whatever unit the SKU trades in -
    ///      kilograms, throughout this product. Fractions are not representable,
    ///      deliberately: a floor denominated in fractional kilograms is a
    ///      rounding argument rather than a price. Callers that hold a fractional
    ///      quantity round UP, which moves the required total in the supplier's
    ///      favour, because this parameter exists to protect the supplier.
    function createDeal(
        address buyer,
        address supplier,
        uint128 amount,
        uint128 quantity,
        uint64 deliveryDeadline,
        bytes32 termsHash
    ) external lock returns (uint256 dealId) {
        if (amount == 0) revert ZeroAmount();
        if (quantity == 0) revert ZeroQuantity();
        if (deliveryDeadline <= block.timestamp) revert DeadlineInPast();
        if (!registry.isRegistered(supplier)) revert SupplierNotRegistered();

        Policy storage p = policies[buyer];
        if (!p.active) revert PolicyInactive();
        if (msg.sender != p.agent) revert NotAuthorisedAgent(msg.sender, p.agent);
        if (p.expiry <= block.timestamp) revert PolicyExpired();
        if (amount > p.maxPerDeal) revert ExceedsPerDealCap(amount, p.maxPerDeal);
        uint128 remaining = p.maxTotal > p.spent ? p.maxTotal - p.spent : 0;
        if (amount > remaining) revert ExceedsTotalCap(amount, remaining);

        /*
         * The supplier's half. Note that the supplier is not the caller and has
         * not signed anything here: this block enforces terms the supplier
         * published earlier against a transaction it is not party to. That is
         * what makes it a floor rather than a negotiating position.
         *
         * The comparison multiplies rather than divides. For positive integers
         * the two are equivalent - floor(amount/quantity) >= minUnitPrice holds
         * exactly when amount >= minUnitPrice*quantity - so this is not a bug
         * fix, and claiming otherwise in a comment would be worse than saying
         * nothing. It is preferred because the quantity never appears in a
         * denominator, which is one fewer thing to prove non-zero, and because
         * what the contract is actually deciding is whether the TOTAL clears
         * the floor, so comparing totals says what is meant.
         *
         * The division below is only in the revert argument. It truncates, so a
         * reported unit price can read a fraction of a cent low; that is a
         * message, not a decision.
         *
         * Both factors were capped at 2**64 when the policy was published, so
         * the product cannot overflow uint256 and the check cannot be made to
         * wrap by a supplier publishing extreme numbers.
         */
        SellerPolicy storage s = sellerPolicies[supplier];
        if (s.active) {
            if (s.expiry <= block.timestamp) revert SellerPolicyExpired();
            if (quantity > s.maxPerDeal) revert ExceedsSellerPerDealCap(quantity, s.maxPerDeal);
            uint128 capacity = s.maxTotal > s.committed ? s.maxTotal - s.committed : 0;
            if (quantity > capacity) revert ExceedsSellerCapacity(quantity, capacity);
            if (uint256(amount) < uint256(s.minUnitPrice) * uint256(quantity)) {
                revert BelowSellerFloor(uint128(amount / quantity), s.minUnitPrice, quantity);
            }
            s.committed += quantity;
        }

        p.spent += amount;

        dealId = ++dealCount;
        deals[dealId] = Deal({
            buyer: buyer,
            supplier: supplier,
            amount: amount,
            quantity: quantity,
            deliveryDeadline: deliveryDeadline,
            createdAt: uint64(block.timestamp),
            shippedAt: 0,
            deliveredAt: 0,
            termsHash: termsHash,
            shipmentHash: bytes32(0),
            state: State.Funded
        });

        require(token.transferFrom(buyer, address(this), amount), "escrow: funding failed");
        emit DealCreated(dealId, buyer, supplier, amount, quantity, deliveryDeadline, termsHash);
    }

    /// @notice Supplier attests that the goods were dispatched.
    /// @dev The first of the two signatures a settlement now needs.
    ///
    ///      Previously the buyer alone confirmed delivery, which meant one key
    ///      could walk a deal from funded to paid with nothing having shipped.
    ///      A buyer who wanted to move money to a supplier under the appearance
    ///      of a purchase needed to convince nobody.
    ///
    ///      Now the supplier's own key has to say it shipped and the buyer's key
    ///      has to say it arrived. Be precise about what that buys: it does not
    ///      make a fictitious delivery impossible, it makes it require two
    ///      parties instead of one. A buyer and a supplier who are working
    ///      together can still settle a deal that never moved. Closing that
    ///      needs an attestation from somebody with no stake in the trade, which
    ///      means a carrier or an inspector, which is a partnership rather than
    ///      a function. See the README.
    ///
    ///      shipmentHash is opaque here on purpose. It is a reference to
    ///      whatever the supplier considers evidence, an airway bill or a
    ///      dispatch note, and this contract neither reads nor validates it. A
    ///      contract that pretended to verify a document it cannot see would be
    ///      worse than one that plainly stores a reference to it.
    function attestShipment(uint256 dealId, bytes32 shipmentHash) external {
        Deal storage d = deals[dealId];
        if (d.state != State.Funded) revert BadState(d.state);
        if (msg.sender != d.supplier) revert NotSupplier();
        if (d.shippedAt != 0) revert AlreadyShipped();
        d.shippedAt = uint64(block.timestamp);
        d.shipmentHash = shipmentHash;
        emit ShipmentAttested(dealId, d.supplier, d.shippedAt, shipmentHash);
    }

    /// @notice Buyer confirms goods were received.
    /// @dev The second signature. Refuses until the supplier has attested, so
    ///      the buyer cannot confirm receipt of something nobody claims to have
    ///      sent.
    function confirmDelivery(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.state != State.Funded) revert BadState(d.state);
        if (msg.sender != d.buyer) revert NotBuyer();
        if (d.shippedAt == 0) revert NotShipped();
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

        /*
         * And the supplier's capacity, for the same reason. A deal that was
         * refunded because nothing arrived did not consume the supplier's
         * month. Leaving `committed` raised would quietly shrink a supplier's
         * sellable capacity every time it failed to deliver - a second penalty
         * on top of the dispute the registry already records, imposed by an
         * accounting oversight rather than by anybody's decision.
         *
         * Guarded the same way `spent` is: if the policy was revoked and
         * re-published between funding and refund, `committed` may be lower
         * than this deal's quantity, and an underflow here would revert the
         * buyer's refund over the supplier's bookkeeping.
         */
        SellerPolicy storage s = sellerPolicies[d.supplier];
        s.committed = s.committed > d.quantity ? s.committed - d.quantity : 0;

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
