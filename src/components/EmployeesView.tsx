import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Edit3,
  MessageCircle,
  Phone,
  Plus,
  Search,
  Smartphone,
  Trash2,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type Employee,
  type Sale,
  type StoreConfig,
  type TableSession,
  type WaiterAccess,
} from '../types';
import { formatMoney, generateSafeId } from '../utils/posHelpers';

interface EmployeesViewProps {
  store: StoreConfig;
  employees: Employee[];
  sales: Sale[];
  tableSessions: TableSession[];
  ownerId: string;
}

const RESTAURANT_ROLES = ['Waiter', 'Cashier', 'Order Taker', 'Delivery Rider', 'Manager', 'Chef'];
const RETAIL_ROLES = ['Sales Staff', 'Cashier', 'Store Keeper', 'Manager', 'Delivery Rider'];
const SHIFT_OPTIONS = ['Full Day', 'Morning', 'Evening', 'Night'];
const NEW_ROLE_OPTION = '__custom_role__';

function formatWhatsAppPhone(rawPhone: string): string {
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('03') && digits.length === 11) return `92${digits.slice(1)}`;
  return digits;
}

export const EmployeesView: React.FC<EmployeesViewProps> = ({
  store,
  employees,
  sales,
  tableSessions,
  ownerId,
}) => {
  const isRetail = store.businessType === 'retail';
  const presetRoles = isRetail ? RETAIL_ROLES : RESTAURANT_ROLES;

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);

  const [name, setName] = useState('');
  const [roleChoice, setRoleChoice] = useState<string>(presetRoles[0]);
  const [customRole, setCustomRole] = useState('');
  const [phone, setPhone] = useState('');
  const [cnic, setCnic] = useState('');
  const [shift, setShift] = useState('Full Day');
  const [notes, setNotes] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [mobileAccess, setMobileAccess] = useState(false);
  const [active, setActive] = useState(true);

  const [accessMap, setAccessMap] = useState<Map<string, WaiterAccess>>(new Map());
  const [copiedLink, setCopiedLink] = useState(false);

  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const waiterAppUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/?mode=waiter';
    return `${window.location.origin}/?mode=waiter`;
  }, []);

  // Track owner's /waiterAccess grants so we know cleanly whether to set or update
  useEffect(() => {
    if (isRetail || !ownerId) {
      setAccessMap(new Map());
      return;
    }
    const q = query(collection(db, 'waiterAccess'), where('ownerId', '==', ownerId));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next = new Map<string, WaiterAccess>();
        snap.docs.forEach((d) => {
          const data = d.data() as Omit<WaiterAccess, 'id'>;
          if (data.storeId === store.id) {
            next.set(d.id, { id: d.id, ...data });
          }
        });
        setAccessMap(next);
      },
      () => {
        // Non-blocking fallback
      }
    );
    return () => unsub();
  }, [isRetail, ownerId, store.id]);

  const handleCopyWaiterLink = async () => {
    try {
      await navigator.clipboard.writeText(waiterAppUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2200);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  };

  const buildWhatsAppInviteHref = (emp: Employee) => {
    const waPhone = formatWhatsAppPhone(emp.phone);
    const lines = [
      `Assalam-o-Alaikum ${emp.name}!`,
      `${store.name} ka Waiter Mobile App access active kar diya gaya hai.`,
      '',
      `1. App Link: ${waiterAppUrl}`,
      `2. Google Sign-In Email: ${emp.loginEmail || ''}`,
      '',
      'Mobile par open karein, apne Gmail se sign in karein, aur table orders & KOT print karein.',
    ];
    const encoded = encodeURIComponent(lines.join('\n'));
    return waPhone ? `https://wa.me/${waPhone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
  };

  const existingRoles = useMemo(() => {
    const set = new Set<string>(presetRoles);
    employees.forEach((e) => {
      if (e.role.trim()) set.add(e.role.trim());
    });
    return Array.from(set);
  }, [employees, presetRoles]);

  // Compute accountability metrics per employee across all sales and currently open tables
  const employeeStats = useMemo(() => {
    const map = new Map<
      string,
      {
        completedOrders: number;
        voidedOrders: number;
        revenue: number;
        discounts: number;
        activeTables: string[];
      }
    >();

    const ensure = (id: string) => {
      let cur = map.get(id);
      if (!cur) {
        cur = { completedOrders: 0, voidedOrders: 0, revenue: 0, discounts: 0, activeTables: [] };
        map.set(id, cur);
      }
      return cur;
    };

    for (const s of sales) {
      if (!s.employeeId) continue;
      const st = ensure(s.employeeId);
      if (s.status === 'voided') {
        st.voidedOrders += 1;
      } else {
        st.completedOrders += 1;
        st.revenue += s.total;
        st.discounts += s.discount;
      }
    }

    for (const t of tableSessions) {
      if (!t.employeeId) continue;
      const st = ensure(t.employeeId);
      st.activeTables.push(t.tableNumber);
    }

    return map;
  }, [sales, tableSessions]);

  const summary = useMemo(() => {
    const total = employees.length;
    const activeCount = employees.filter((e) => e.active).length;
    const attributedSales = sales.filter((s) => !!s.employeeId && s.status === 'completed').length;
    const attributedVoids = sales.filter((s) => !!s.employeeId && s.status === 'voided').length;
    const mobileEnabledCount = employees.filter(
      (e) => e.active && e.mobileAccess && Boolean(e.loginEmail)
    ).length;
    return { total, activeCount, attributedSales, attributedVoids, mobileEnabledCount };
  }, [employees, sales]);

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((emp) => {
      if (statusFilter === 'active' && !emp.active) return false;
      if (statusFilter === 'inactive' && emp.active) return false;
      if (!q) return true;
      return (
        emp.name.toLowerCase().includes(q) ||
        emp.role.toLowerCase().includes(q) ||
        emp.phone.toLowerCase().includes(q) ||
        emp.cnic.toLowerCase().includes(q) ||
        (emp.loginEmail ?? '').toLowerCase().includes(q)
      );
    });
  }, [employees, search, statusFilter]);

  const openAddModal = () => {
    setEditingEmployee(null);
    setName('');
    setRoleChoice(presetRoles[0]);
    setCustomRole('');
    setPhone('');
    setCnic('');
    setShift('Full Day');
    setNotes('');
    setLoginEmail('');
    setMobileAccess(false);
    setActive(true);
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (emp: Employee) => {
    setEditingEmployee(emp);
    setName(emp.name);
    if (existingRoles.includes(emp.role)) {
      setRoleChoice(emp.role);
      setCustomRole('');
    } else {
      setRoleChoice(NEW_ROLE_OPTION);
      setCustomRole(emp.role);
    }
    setPhone(emp.phone);
    setCnic(emp.cnic);
    setShift(emp.shift || 'Full Day');
    setNotes(emp.notes);
    setLoginEmail(emp.loginEmail ?? '');
    setMobileAccess(Boolean(emp.mobileAccess));
    setActive(emp.active);
    setFormError(null);
    setModalOpen(true);
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim().slice(0, BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX);
    const resolvedRole = (roleChoice === NEW_ROLE_OPTION ? customRole : roleChoice)
      .trim()
      .slice(0, BLUEPRINT_LIMITS.EMPLOYEE_ROLE_MAX);
    const cleanEmail = loginEmail
      .trim()
      .toLowerCase()
      .slice(0, BLUEPRINT_LIMITS.EMPLOYEE_EMAIL_MAX);
    const enableMobile = !isRetail && mobileAccess;

    if (!cleanName) {
      setFormError('Employee name is required.');
      return;
    }
    if (!resolvedRole) {
      setFormError('Please select or enter a role.');
      return;
    }
    if (enableMobile && (cleanEmail.length < 3 || !cleanEmail.includes('@'))) {
      setFormError('Please enter a valid Google Email (Gmail) to enable Waiter Mobile Access.');
      return;
    }

    setSaving(true);
    setFormError(null);

    const payload = {
      name: cleanName,
      role: resolvedRole,
      phone: phone.trim().slice(0, BLUEPRINT_LIMITS.PHONE_MAX),
      cnic: cnic.trim().slice(0, BLUEPRINT_LIMITS.EMPLOYEE_CNIC_MAX),
      shift: shift.trim().slice(0, BLUEPRINT_LIMITS.EMPLOYEE_SHIFT_MAX),
      notes: notes.trim().slice(0, BLUEPRINT_LIMITS.EMPLOYEE_NOTES_MAX),
      loginEmail: cleanEmail,
      mobileAccess: enableMobile,
      active,
    };

    const empId = editingEmployee ? editingEmployee.id : generateSafeId('emp');
    const accessId = `${store.id}_${empId}`;
    const empPath = `stores/${store.id}/employees/${empId}`;

    try {
      const batch = writeBatch(db);
      const empRef = doc(db, 'stores', store.id, 'employees', empId);

      if (editingEmployee) {
        batch.update(empRef, {
          ...payload,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(empRef, {
          ownerId,
          storeId: store.id,
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      if (!isRetail) {
        const accessRef = doc(db, 'waiterAccess', accessId);
        const existingGrant = accessMap.get(accessId);
        if (enableMobile && cleanEmail) {
          if (existingGrant) {
            batch.update(accessRef, {
              storeName: store.name.slice(0, BLUEPRINT_LIMITS.STORE_NAME_MAX),
              employeeName: cleanName,
              role: resolvedRole,
              waiterEmail: cleanEmail,
              active: active && enableMobile,
              updatedAt: serverTimestamp(),
            });
          } else {
            batch.set(accessRef, {
              ownerId,
              storeId: store.id,
              storeName: store.name.slice(0, BLUEPRINT_LIMITS.STORE_NAME_MAX),
              employeeId: empId,
              employeeName: cleanName,
              role: resolvedRole,
              waiterEmail: cleanEmail,
              active: active && enableMobile,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        } else if (existingGrant) {
          batch.update(accessRef, {
            active: false,
            updatedAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();
      setModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save employee.');
      handleFirestoreError(
        err,
        editingEmployee ? OperationType.UPDATE : OperationType.CREATE,
        empPath
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (emp: Employee) => {
    setTogglingId(emp.id);
    const nextActive = !emp.active;
    const accessId = `${store.id}_${emp.id}`;
    const path = `stores/${store.id}/employees/${emp.id}`;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'stores', store.id, 'employees', emp.id), {
        active: nextActive,
        updatedAt: serverTimestamp(),
      });
      if (!isRetail && accessMap.has(accessId)) {
        batch.update(doc(db, 'waiterAccess', accessId), {
          active: nextActive && Boolean(emp.mobileAccess),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDeleteEmployee = async (emp: Employee) => {
    setDeletingId(emp.id);
    const accessId = `${store.id}_${emp.id}`;
    const path = `stores/${store.id}/employees/${emp.id}`;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'stores', store.id, 'employees', emp.id));
      if (!isRetail && accessMap.has(accessId)) {
        batch.delete(doc(db, 'waiterAccess', accessId));
      }
      await batch.commit();
      setConfirmDeleteId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Staff Accountability KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Total Staff</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {summary.total}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Active on Duty</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
            {summary.activeCount}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Tracked Orders</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {summary.attributedSales}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Voided Bills (Tracked)</div>
          <div
            className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
              summary.attributedVoids > 0
                ? 'text-red-600 dark:text-red-400'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {summary.attributedVoids}
          </div>
        </div>
      </div>

      {/* Waiter Mobile App Access Link Bar (Restaurant Mode Only) */}
      {!isRetail && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg brand-soft-bg brand-text flex items-center justify-center shrink-0 mt-0.5">
              <Smartphone className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
                  Waiter Mobile App Access
                </h3>
                <span className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 font-semibold">
                  {summary.mobileEnabledCount} active waiter{summary.mobileEnabledCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                Add a waiter&apos;s Google Email below and enable Mobile Access. Waiters open this link on their mobile phone to place direct table orders and print KOTs — without access to your sales, profits, or store settings.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <code className="hidden sm:block max-w-[230px] truncate rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
              {waiterAppUrl}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyWaiterLink()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
            >
              {copiedLink ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-emerald-700 dark:text-emerald-400">Link Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Waiter Link</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Staff Directory Card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, role, phone, CNIC..."
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'active', label: 'Active' },
                  { id: 'inactive', label: 'Inactive' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                    statusFilter === tab.id
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={openAddModal}
            className="inline-flex items-center gap-1.5 rounded-lg brand-bg px-3.5 py-2 text-xs font-semibold text-white whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Employee</span>
          </button>
        </div>

        {employees.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Users className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600" />
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              No employees added yet
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Add your waiters, cashiers, or staff members here. When taking orders or booking tables, you can select who handled each table so every bill and mistake is tracked accurately.
            </p>
            <button
              type="button"
              onClick={openAddModal}
              className="inline-flex items-center gap-1.5 rounded-lg brand-bg px-4 py-2.5 text-sm font-semibold text-white cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add First Employee</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/80 dark:bg-slate-950/40">
                  <th className="py-3 px-4">Employee</th>
                  <th className="py-3 px-4">Contact & CNIC</th>
                  <th className="py-3 px-4">Shift</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Orders</th>
                  <th className="py-3 px-4 text-right">Sales Total</th>
                  <th className="py-3 px-4 text-right">Voided</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {filteredEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                      No employees match your search filter.
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((emp) => {
                    const stats = employeeStats.get(emp.id) ?? {
                      completedOrders: 0,
                      voidedOrders: 0,
                      revenue: 0,
                      discounts: 0,
                      activeTables: [],
                    };
                    return (
                      <tr
                        key={emp.id}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            {emp.name}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {emp.role}
                            {stats.activeTables.length > 0 && (
                              <span className="text-amber-700 dark:text-amber-400 font-medium">
                                {' '}
                                · Active: T-{stats.activeTables.join(', T-')}
                              </span>
                            )}
                          </div>
                          {emp.notes && (
                            <div className="text-[11px] text-slate-400 truncate max-w-[220px]">
                              {emp.notes}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">
                          {emp.phone ? (
                            <div className="inline-flex items-center gap-1">
                              <Phone className="w-3 h-3 text-slate-400" />
                              <span>{emp.phone}</span>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                          {emp.cnic && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              ID: {emp.cnic}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                          {emp.shift || 'Full Day'}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-col items-start gap-1">
                            <button
                              type="button"
                              disabled={togglingId === emp.id}
                              onClick={() => void handleToggleActive(emp)}
                              className={`inline-flex items-center gap-1 font-medium cursor-pointer ${
                                emp.active
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-slate-400 dark:text-slate-500'
                              }`}
                              title="Click to toggle active/inactive"
                            >
                              {emp.active ? (
                                <UserCheck className="w-3.5 h-3.5" />
                              ) : (
                                <UserX className="w-3.5 h-3.5" />
                              )}
                              <span>{emp.active ? 'Active' : 'Inactive'}</span>
                            </button>
                            {!isRetail && emp.mobileAccess && emp.loginEmail && (
                              <div className="flex flex-col">
                                <span
                                  className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                                    emp.active
                                      ? 'text-teal-700 dark:text-teal-400'
                                      : 'text-slate-400 dark:text-slate-500'
                                  }`}
                                >
                                  <Smartphone className="w-3 h-3" />
                                  <span>{emp.active ? 'Mobile App ON' : 'Mobile Paused'}</span>
                                </span>
                                <span className="text-[10px] font-mono text-slate-400 truncate max-w-[160px]">
                                  {emp.loginEmail}
                                </span>
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                          {stats.completedOrders}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                          {formatMoney(stats.revenue, store.currency)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {stats.voidedOrders > 0 ? (
                            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 font-semibold">
                              <AlertTriangle className="w-3 h-3" />
                              <span>{stats.voidedOrders}</span>
                            </span>
                          ) : (
                            <span className="text-slate-400">0</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {confirmDeleteId === emp.id ? (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={deletingId === emp.id}
                                onClick={() => void handleDeleteEmployee(emp)}
                                className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-semibold text-white cursor-pointer"
                              >
                                {deletingId === emp.id ? '...' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-1.5 py-1 cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              {!isRetail && emp.active && emp.mobileAccess && emp.loginEmail && (
                                <a
                                  href={buildWhatsAppInviteHref(emp)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/70 transition-colors"
                                  title="Send Waiter Mobile App invite on WhatsApp"
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                  <span className="hidden sm:inline">Invite</span>
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => openEditModal(emp)}
                                className="rounded-lg p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                title="Edit employee"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(emp.id)}
                                className="rounded-lg p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                                title="Delete employee"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Employee Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl my-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                  {editingEmployee ? 'Edit Employee' : 'Add New Employee'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Active employees appear in the Billing dropdown for every table & order.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveEmployee(e)} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Employee Full Name *
                </label>
                <input
                  type="text"
                  required
                  maxLength={BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Ali Khan"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Role / Position *
                  </label>
                  <select
                    value={roleChoice}
                    onChange={(e) => setRoleChoice(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  >
                    {existingRoles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    <option value={NEW_ROLE_OPTION}>+ Custom Role...</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Shift
                  </label>
                  <select
                    value={shift}
                    onChange={(e) => setShift(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  >
                    {SHIFT_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {roleChoice === NEW_ROLE_OPTION && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Custom Role Name *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={BLUEPRINT_LIMITS.EMPLOYEE_ROLE_MAX}
                    value={customRole}
                    onChange={(e) => setCustomRole(e.target.value)}
                    placeholder="e.g., Floor Supervisor"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Phone Number (Optional)
                  </label>
                  <input
                    type="tel"
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="0300-1234567"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    CNIC / Staff ID (Optional)
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.EMPLOYEE_CNIC_MAX}
                    value={cnic}
                    onChange={(e) => setCnic(e.target.value)}
                    placeholder="35202-1234567-1"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Notes / Address (Optional)
                </label>
                <input
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.EMPLOYEE_NOTES_MAX}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Salary note, joining date, or home address..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>

              {!isRetail && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-3.5 space-y-2.5">
                  <label className="flex items-start gap-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mobileAccess}
                      onChange={(e) => setMobileAccess(e.target.checked)}
                      className="rounded border-slate-300 mt-0.5"
                    />
                    <span>
                      Enable Waiter Mobile App Access
                      <span className="block text-[11px] font-normal text-slate-500 dark:text-slate-400 mt-0.5">
                        Allows this staff member to place table orders & print KOTs from their phone.
                      </span>
                    </span>
                  </label>

                  {mobileAccess && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Waiter Google Email (Gmail) *
                      </label>
                      <input
                        type="email"
                        required={mobileAccess}
                        maxLength={BLUEPRINT_LIMITS.EMPLOYEE_EMAIL_MAX}
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        placeholder="waiter.name@gmail.com"
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
                      />
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                        Waiter signs in with this exact Google account on their mobile.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Active employee (show in Billing dropdown)</span>
              </label>

              {formError && (
                <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {formError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
                >
                  {saving ? 'Saving...' : editingEmployee ? 'Update Employee' : 'Save Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
