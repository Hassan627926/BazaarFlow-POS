/**
 * Firestore Security Rules TDD Specification ("Dirty Dozen" Payloads)
 * Designed to verify PERMISSION_DENIED on all 12 adversarial cases against firestore.rules.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  path: string;
  operation: 'create' | 'update' | 'delete' | 'get' | 'list';
  expected: 'PERMISSION_DENIED';
  payload?: Record<string, unknown>;
  reason: string;
}

export const DIRTY_DOZEN_TESTS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Identity Spoofing on Store Create',
    path: '/stores/store_spoof',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'other_user_uid', name: 'Hijack Store', businessType: 'retail' },
    reason: 'ownerId does not match request.auth.uid',
  },
  {
    id: 2,
    name: 'Shadow Field Injection on Store Create',
    path: '/stores/store_shadow',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'user_a', name: 'Valid Store', isAdmin: true },
    reason: 'Extra unallowlisted key rejected by hasOnly()',
  },
  {
    id: 3,
    name: 'Unverified Email Spoof Write',
    path: '/stores/store_unverified',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'unverified_uid', name: 'Shop' },
    reason: 'request.auth.token.email_verified must be true',
  },
  {
    id: 4,
    name: 'Path Variable ID Poisoning (150+ chars)',
    path: `/stores/${'a'.repeat(160)}`,
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    reason: 'isValidId() rejects IDs over 128 chars or invalid characters',
  },
  {
    id: 5,
    name: 'Orphaned Product Write on Missing Store',
    path: '/stores/non_existent_store/products/prod_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'user_a', storeId: 'non_existent_store', name: 'Orphan Item' },
    reason: 'Master Gate rejects write when parent store does not exist or is not owned by caller',
  },
  {
    id: 6,
    name: 'Cross-Tenant List Query Scraping',
    path: '/stores/store_a/products',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    reason: 'allow list requires resource.data.ownerId == request.auth.uid',
  },
  {
    id: 7,
    name: 'Immutable Field Mutation on Product Update',
    path: '/stores/store_a/products/prod_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'attacker_uid', storeId: 'store_b' },
    reason: 'affectedKeys().hasOnly() blocks mutating ownerId, storeId, or createdAt',
  },
  {
    id: 8,
    name: 'Value Poisoning on Store Theme Color & Tax',
    path: '/stores/store_a',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { primaryColor: 'javascript:alert(1)', taxRate: 9999 },
    reason: 'isValidStore(incoming()) enforces hex regex and 0..50 tax bounds on every update',
  },
  {
    id: 9,
    name: 'Terminal State Bypass on Voided Sale',
    path: '/stores/store_a/sales/sale_voided',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { status: 'completed', total: 0 },
    reason: 'Voided sales are terminally locked and financial totals are immutable',
  },
  {
    id: 10,
    name: 'Stock Audit Log Deletion / Modification',
    path: '/stores/store_a/stockLogs/log_1',
    operation: 'delete',
    expected: 'PERMISSION_DENIED',
    reason: 'Stock logs are strictly append-only (update and delete forbidden)',
  },
  {
    id: 11,
    name: 'Client Backdated Timestamp Forgery',
    path: '/stores/store_a/sales/sale_fake_time',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { createdAt: '2020-01-01T00:00:00Z' },
    reason: 'Temporal integrity requires incoming().createdAt == request.time',
  },
  {
    id: 12,
    name: 'Empty or Oversized Items Array Bomb on Sale',
    path: '/stores/store_a/sales/sale_bomb',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { items: [] },
    reason: 'Total Array Guarding enforces items.size() >= 1 && items.size() <= 100',
  },
];
