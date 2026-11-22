import React, { useMemo, useState } from 'react';
import { Download, Eye, Printer, RotateCcw, Search, X } from 'lucide-react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type Employee,
  type PaymentMethod,
  type PrintJob,
  type Product,
  type Sale,
  type StoreConfig,
} from '../types';
import {
  exportSalesLedgerCSV,
  formatDateTime,
  formatMoney,
  generateSafeId,
  getTodayDateKey,
} from '../utils/posHelpers';

interface SalesHistoryViewProps {
  store: StoreConfig;
  sales: Sale[];
  products: Product[];
  employees: Employee[];
  ownerId: string;
  onPrintJob: (job: PrintJob) => void;
}

export const SalesHistoryView: React.FC<SalesHistoryViewProps> = ({
  store,
  sales,
  products,
  employees,
  ownerId,
  onPrintJob,
}) => {
  const isRetail = store.businessType === 'retail';
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<'today' | 'all' | 'custom'>('today');
  const [customDate, setCustomDate] = useState(getTodayDateKey());
  const [paymentFilter, setPaymentFilter] = useState<'all' | PaymentMethod>('all');
  const [employeeFilter, setEmployeeFilter] = useState<string>('all');
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  const todayKey = getTodayDateKey();

  const employeeFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    employees.forEach((e) => map.set(e.id, e.name));
    sales.forEach((s) => {
      if (s.employeeId && s.employeeName && !map.has(s.employeeId)) {
        map.set(s.employeeId, s.employeeName);
      }
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [employees, sales]);

  const filteredSales = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sales.filter((s) => {
      if (dateFilter === 'today' && s.dateKey !== todayKey) return false;
      if (dateFilter === 'custom' && s.dateKey !== customDate) return false;
      if (paymentFilter !== 'all' && s.paymentMethod !== paymentFilter) return false;
      if (employeeFilter === '__unassigned__' && s.employeeId) return false;
      if (employeeFilter !== 'all' && employeeFilter !== '__unassigned__' && s.employeeId !== employeeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        s.invoiceNumber.toLowerCase().includes(q) ||
        s.customerName.toLowerCase().includes(q) ||
        (s.customerPhone ?? '').toLowerCase().includes(q) ||
        (s.employeeName ?? '').toLowerCase().includes(q) ||
        s.tableNumber.toLowerCase().includes(q) ||
        s.items.some((i) => i.name.toLowerCase().includes(q))
      );
    });
  }, [sales, dateFilter, customDate, todayKey, paymentFilter, employeeFilter, search]);

  const summary = useMemo(() => {
    const completed = filteredSales.filter((s) => s.status === 'completed');
    const revenue = completed.reduce((acc, s) => acc + s.total, 0);
    const profit = completed.reduce((acc, s) => acc + s.profit, 0);
    return { count: completed.length, revenue, profit };
  }, [filteredSales]);

  const handleVoidSale = async (sale: Sale) => {
    if (sale.status === 'voided') return;
    setVoidingId(sale.id);
    const path = `stores/${store.id}/sales/${sale.id}`;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'stores', store.id, 'sales', sale.id), {
        status: 'voided',
        updatedAt: serverTimestamp(),
      });

      const productMap = new Map(products.map((p) => [p.id, p]));
      for (const item of sale.items) {
        const prod = productMap.get(item.productId);
        if (prod) {
          const restoredStock = Number((prod.stock + item.quantity).toFixed(2));
          batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
            stock: restoredStock,
            updatedAt: serverTimestamp(),
          });

          const logId = generateSafeId('log');
          batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
            ownerId,
            storeId: store.id,
            productId: prod.id,
            productName: prod.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
            change: item.quantity,
            previousStock: prod.stock,
            newStock: restoredStock,
            reason: 'void_restore',
            note: `Voided ${sale.invoiceNumber}`.slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
            createdAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();
      if (selectedSale?.id === sale.id) {
        setSelectedSale({ ...sale, status: 'voided' });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setVoidingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Filter Summary Header */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Filtered Revenue</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(summary.revenue, store.currency)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Gross Profit</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
            {formatMoney(summary.profit, store.currency)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Completed Bills</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {summary.count}
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(
                [
                  { id: 'today', label: 'Today' },
                  { id: 'all', label: 'All History' },
                  { id: 'custom', label: 'Date' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDateFilter(tab.id)}
                  className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                    dateFilter === tab.id
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {dateFilter === 'custom' && (
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            )}

            <select
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value as 'all' | PaymentMethod)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200"
            >
              <option value="all">All Payments</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="bank_qr">Bank / QR</option>
            </select>

            {employeeFilterOptions.length > 0 && (
              <select
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Employees</option>
                {employeeFilterOptions.map(([id, empName]) => (
                  <option key={id} value={id}>
                    {empName}
                  </option>
                ))}
                <option value="__unassigned__">Unassigned</option>
              </select>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search invoice # or item..."
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            <button
              type="button"
              onClick={() => exportSalesLedgerCSV(store, filteredSales)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/80 dark:bg-slate-950/40">
                <th className="py-3 px-4">Invoice</th>
                <th className="py-3 px-4">Date & Time</th>
                <th className="py-3 px-4">{isRetail ? 'Customer' : 'Order / Table'}</th>
                <th className="py-3 px-4">Staff</th>
                <th className="py-3 px-4">Payment</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Total</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {filteredSales.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    No sales bills recorded for this filter.
                  </td>
                </tr>
              ) : (
                filteredSales.map((sale) => (
                  <tr
                    key={sale.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-4 font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {sale.invoiceNumber}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {formatDateTime(sale.createdAt)}
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                      {isRetail ? (
                        sale.customerName || 'Walk-in'
                      ) : (
                        <div>
                          <span className="capitalize">{sale.orderType.replace('_', ' ')}</span>
                          {sale.tableNumber ? ` · T-${sale.tableNumber}` : ''}
                          {sale.customerName ? ` · ${sale.customerName}` : ''}
                          {sale.customerPhone && (
                            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                              {sale.customerPhone}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
                      {sale.employeeName || <span className="text-slate-400 font-normal">—</span>}
                    </td>
                    <td className="py-3 px-4 uppercase font-mono text-slate-600 dark:text-slate-300">
                      {sale.paymentMethod.replace('_', '/')}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={
                          sale.status === 'voided'
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : 'text-emerald-700 dark:text-emerald-400 font-medium'
                        }
                      >
                        {sale.status === 'voided' ? 'Voided' : 'Completed'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {formatMoney(sale.total, store.currency)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedSale(sale)}
                          className="rounded-lg p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          title="Inspect bill"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onPrintJob({ type: 'receipt', sale })}
                          className="rounded-lg p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          title="Reprint bill"
                        >
                          <Printer className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sale Inspection Modal */}
      {selectedSale && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl my-auto space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                  Invoice {selectedSale.invoiceNumber}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {formatDateTime(selectedSale.createdAt)} ·{' '}
                  {selectedSale.status === 'voided' ? 'Voided' : 'Completed'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSale(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(selectedSale.employeeName ||
              selectedSale.customerName ||
              selectedSale.customerPhone ||
              selectedSale.customerAddress ||
              selectedSale.tableNumber) && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 text-xs space-y-1 text-slate-700 dark:text-slate-300">
                {selectedSale.employeeName && (
                  <div>
                    <span className="text-slate-500">Handled By (Staff):</span>{' '}
                    <strong className="text-slate-900 dark:text-slate-100">
                      {selectedSale.employeeName}
                    </strong>
                  </div>
                )}
                {selectedSale.tableNumber && (
                  <div>
                    <span className="text-slate-500">Table:</span> Table {selectedSale.tableNumber}
                  </div>
                )}
                {selectedSale.customerName && (
                  <div>
                    <span className="text-slate-500">Customer:</span> {selectedSale.customerName}
                  </div>
                )}
                {selectedSale.customerPhone && (
                  <div>
                    <span className="text-slate-500">Phone:</span>{' '}
                    <span className="font-mono">{selectedSale.customerPhone}</span>
                  </div>
                )}
                {selectedSale.customerAddress && (
                  <div>
                    <span className="text-slate-500">Delivery Address:</span>{' '}
                    {selectedSale.customerAddress}
                  </div>
                )}
              </div>
            )}

            <div className="border-y border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {selectedSale.items.map((item, idx) => (
                <div key={`${item.productId}-${idx}`} className="py-2.5 flex justify-between gap-2">
                  <div>
                    <div className="font-medium text-slate-900 dark:text-slate-100">{item.name}</div>
                    <div className="text-slate-500 dark:text-slate-400 font-mono">
                      {item.quantity} × {formatMoney(item.unitPrice, store.currency)}
                    </div>
                  </div>
                  <div className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {formatMoney(item.lineTotal, store.currency)}
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Subtotal</span>
                <span className="font-mono tabular-nums">
                  {formatMoney(selectedSale.subtotal, store.currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Tax ({selectedSale.taxRate ?? 0}%)</span>
                <span className="font-mono tabular-nums">
                  {formatMoney(selectedSale.taxAmount ?? 0, store.currency)}
                </span>
              </div>
              {selectedSale.discount > 0 && (
                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Discount</span>
                  <span className="font-mono tabular-nums">
                    -{formatMoney(selectedSale.discount, store.currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-sm font-bold text-slate-900 dark:text-slate-100">
                <span>Grand Total</span>
                <span className="font-mono tabular-nums">
                  {formatMoney(selectedSale.total, store.currency)}
                </span>
              </div>
              {selectedSale.paymentMethod === 'cash' && (
                <div className="pt-1.5 space-y-1 border-t border-dashed border-slate-200 dark:border-slate-800">
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Cash Received</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(selectedSale.amountTendered, store.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold text-emerald-700 dark:text-emerald-400">
                    <span>Change / Return</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(selectedSale.changeDue ?? 0, store.currency)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              {selectedSale.status === 'completed' ? (
                <button
                  type="button"
                  disabled={voidingId === selectedSale.id}
                  onClick={() => void handleVoidSale(selectedSale)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-900 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>
                    {voidingId === selectedSale.id ? 'Voiding...' : 'Void Sale & Restore Stock'}
                  </span>
                </button>
              ) : (
                <span className="text-xs text-red-600 dark:text-red-400 font-medium">
                  This sale is voided and stock was restored.
                </span>
              )}

              <div className="flex items-center gap-2">
                {!isRetail && (
                  <button
                    type="button"
                    onClick={() => onPrintJob({ type: 'kot', sale: selectedSale })}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    Print KOT
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onPrintJob({ type: 'receipt', sale: selectedSale })}
                  className="inline-flex items-center gap-1.5 rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Reprint Bill</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
