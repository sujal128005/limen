// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SupplierRegistry
/// @notice Portable supplier identity + reputation earned strictly from settled trade.
/// @dev The core integrity property: reputation can ONLY be written by an authorized
///      settlement contract (the escrow). No one - not the supplier, not the platform
///      operator, not a buyer - can write a score directly. Every point of reputation
///      corresponds to a real escrow settlement recorded on this chain.
contract SupplierRegistry {
    uint32 public constant SCORE_SCALE = 10000; // basis points -> 9400 renders as 94.00
    uint32 public constant INITIAL_SCORE = 5000; // unproven suppliers start neutral

    struct Supplier {
        bytes32 externalId;      // hash of the off-chain catalog id
        address wallet;
        uint64  completedDeals;
        uint64  disputedDeals;
        uint64  lateDeliveries;
        uint128 settledVolume;   // cumulative USDC (6dp) settled through escrow
        uint32  score;           // 0..SCORE_SCALE
        bool    registered;
    }

    address public owner;
    mapping(address => bool) public authorizedSettler;
    mapping(address => Supplier) private _suppliers;
    address[] private _supplierList;

    event SupplierRegistered(address indexed supplier, bytes32 externalId);
    event SettlerAuthorized(address indexed settler, bool allowed);
    event ReputationUpdated(
        address indexed supplier,
        uint32 previousScore,
        uint32 newScore,
        bool onTime,
        uint128 volume
    );
    event DisputeRecorded(address indexed supplier, uint32 previousScore, uint32 newScore);

    error NotOwner();
    error NotAuthorizedSettler();
    error AlreadyRegistered();
    error NotRegistered();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySettler() {
        if (!authorizedSettler[msg.sender]) revert NotAuthorizedSettler();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setSettler(address settler, bool allowed) external onlyOwner {
        authorizedSettler[settler] = allowed;
        emit SettlerAuthorized(settler, allowed);
    }

    function registerSupplier(address wallet, bytes32 externalId) external onlyOwner {
        if (_suppliers[wallet].registered) revert AlreadyRegistered();
        _suppliers[wallet] = Supplier({
            externalId: externalId,
            wallet: wallet,
            completedDeals: 0,
            disputedDeals: 0,
            lateDeliveries: 0,
            settledVolume: 0,
            score: INITIAL_SCORE,
            registered: true
        });
        _supplierList.push(wallet);
        emit SupplierRegistered(wallet, externalId);
    }

    /// @notice Called by the escrow on successful settlement.
    /// @dev Asymmetric update: trust accrues slowly, and a late delivery earns
    ///      materially less than an on-time one. Converges toward SCORE_SCALE
    ///      without ever reaching it, so a perfect record is asymptotic, not gameable.
    function recordSettlement(address supplier, uint128 volume, bool onTime)
        external
        onlySettler
    {
        Supplier storage s = _suppliers[supplier];
        if (!s.registered) revert NotRegistered();

        uint32 prev = s.score;
        uint32 gap = SCORE_SCALE - prev;
        // on-time: close 1/8 of the remaining gap. late: 1/32, and a small penalty.
        uint32 gain = onTime ? gap / 8 : gap / 32;
        uint32 next = prev + gain;
        if (!onTime) {
            uint32 penalty = next / 50; // -2% for missing the agreed window
            next = next > penalty ? next - penalty : 0;
            s.lateDeliveries += 1;
        }

        s.score = next;
        s.completedDeals += 1;
        s.settledVolume += volume;

        emit ReputationUpdated(supplier, prev, next, onTime, volume);
    }

    /// @notice Called by the escrow when a deal is refunded or disputed.
    function recordDispute(address supplier) external onlySettler {
        Supplier storage s = _suppliers[supplier];
        if (!s.registered) revert NotRegistered();
        uint32 prev = s.score;
        uint32 next = prev - (prev / 4); // a dispute costs 25% - far more than a deal earns
        s.score = next;
        s.disputedDeals += 1;
        emit DisputeRecorded(supplier, prev, next);
    }

    function getSupplier(address wallet) external view returns (Supplier memory) {
        return _suppliers[wallet];
    }

    function scoreOf(address wallet) external view returns (uint32) {
        return _suppliers[wallet].score;
    }

    function isRegistered(address wallet) external view returns (bool) {
        return _suppliers[wallet].registered;
    }

    function supplierCount() external view returns (uint256) {
        return _supplierList.length;
    }

    function supplierAt(uint256 i) external view returns (address) {
        return _supplierList[i];
    }
}
