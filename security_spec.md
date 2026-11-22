# BazaarFlow POS — Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Store Ownership Isolation**: Every `/stores/{storeId}` document has an immutable `ownerId` equal to `request.auth.uid`, and requires a verified email (`request.auth.token.email_verified == true`). No user can read, list, create, update, or delete another user's store.
2. **Master Gate Relational Sync**: Every subcollection document under `/stores/{storeId}/products/{productId}`, `/stores/{storeId}/sales/{saleId}`, and `/stores/{storeId}/stockLogs/{logId}` must reference an existing parent `/stores/{storeId}` whose `ownerId == request.auth.uid`, and its own `ownerId` and `storeId` must match.
3. **Business Type Barcode Invariant**: Restaurant stores (`businessType == 'restaurant'`) must not store barcode values on products (`barcode == ''`); retail stores may store up to 48-char barcode strings.
4. **Terminal State Locking on Sales**: A `Sale` is created with `status == 'completed'`. It may only transition once from `'completed'` to `'voided'`. Once `status == 'voided'`, no further updates are permitted. Sales cannot be deleted.
5. **Immutable Audit Logs**: `StockLog` documents are append-only (`allow update, delete: if false`).
6. **Temporal Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update. `updatedAt` must equal `request.time` on both creation and update.
7. **Strict Schema & Bounds**: All strings have explicit `.size()` bounds, all hex colors and IDs match strict regexes, `items` array on `Sale` is bounded `1..100`, and no shadow/unknown keys are allowed.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Identity Spoofing on Store Create**: `{ ownerId: "victim-uid", name: "Hijack Shop", ... }` -> DENIED (`ownerId != request.auth.uid`).
2. **Ghost/Shadow Field Injection on Store Create**: `{ ownerId: "me", ..., isVerified: true, planTier: "enterprise" }` -> DENIED (`hasOnly` check).
3. **Unverified Email Write Attempt**: Authenticated user with `email_verified: false` attempting store/product/sale create -> DENIED (`isVerifiedUser()`).
4. **Oversized ID Poisoning**: Creating `/stores/<200-char-junk-id>` -> DENIED (`isValidId`).
5. **Orphaned Subcollection Write**: Creating `/stores/nonexistent-store/products/prod1` -> DENIED (`exists` / `get` Master Gate).
6. **Cross-Tenant Product Read/List**: User B calling `get` or `list` on User A's `/stores/{storeA}/products` -> DENIED (`resource.data.ownerId == request.auth.uid`).
7. **Immutable Field Tampering**: Updating `storeId`, `ownerId`, or `createdAt` on an existing product -> DENIED (`affectedKeys().hasOnly(...)`).
8. **Value Poisoning on Whitelisted Update Key**: Updating `Store.taxRate` to `999` or `"invalid"` or `Store.primaryColor` to `"not-a-hex"` -> DENIED (`isValidStore(incoming())`).
9. **Terminal State Bypass on Sale**: Updating a `voided` sale back to `completed`, or altering `total` on a completed sale -> DENIED (`existing().status == 'completed'` + `affectedKeys().hasOnly(['status', 'updatedAt'])`).
10. **Audit Log Tampering**: Updating or deleting a `/stores/{storeId}/stockLogs/{logId}` document -> DENIED (`allow update, delete: if false`).
11. **Client Timestamp Forgery**: Creating a `Sale` with backdated `createdAt` (`!= request.time`) -> DENIED (`incoming().createdAt == request.time`).
12. **Array Bomb / Empty Cart Sale**: Creating a `Sale` with `items: []` or `items.size() > 100` -> DENIED (`data.items.size() >= 1 && data.items.size() <= 100`).
