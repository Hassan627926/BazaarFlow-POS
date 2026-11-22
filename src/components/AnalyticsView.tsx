import React, { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Calendar, Download, FileSpreadsheet, Printer } from 'lucide-react';
import type { Employee, PrintJob, Product, Sale, StoreConfig } from '../types';
import {
  exportDailySummaryCSV,
  exportInventoryCSV,
  exportSalesLedgerCSV,
  formatMoney,
  getTodayDateKey,
} from '../utils/posHelpers';

interface AnalyticsViewProps {
  store: StoreConfig;
  sales: Sale[];
  products: Product[];
  employees: Employee[];
  onPrintJob: (job: PrintJob) => void;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  store,
  sales,
  products,
  employees,
  onPrintJob,
}) => {
  const [reportDate, setReportDate] = useState(getTodayDateKey());
  const [rangeDays, setRangeDays] = useState<7 | 30>(7);

  const completedSales = useMemo(
    () => sales.filter((s) => s.status === 'completed'),
    [sales]
  );

  const dayStats = useMemo(() => {
    const dayCompleted = completedSales.filter((s) => s.dateKey === reportDate);
    const dayVoided = sales.filter((s) => s.dateKey === reportDate && s.status === 'voided');

    const revenue = dayCompleted.reduce((a, s) => a + s.total, 0);
    const profit = dayCompleted.reduce((a, s) => a + s.profit, 0);
    const tax = dayCompleted.reduce((a, s) => a + s.taxAmount, 0);
    const orders = dayCompleted.length;
    const avgTicket = orders > 0 ? revenue / orders : 0;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    const cash = dayCompleted
      .filter((s) => s.paymentMethod === 'cash')
      .reduce((a, s) => a + s.total, 0);
    const card = dayCompleted
      .filter((s) => s.paymentMethod === 'card')
      .reduce((a, s) => a + s.total, 0);
    const bankQr = dayCompleted
      .filter((s) => s.paymentMethod === 'bank_qr')
      .reduce((a, s) => a + s.total, 0);

    return {
      revenue,
      profit,
      tax,
      orders,
      voidedCount: dayVoided.length,
      avgTicket,
      margin,
      paymentChart: [
        { method: 'Cash', amount: Number(cash.toFixed(2)) },
        { method: 'Card', amount: Number(card.toFixed(2)) },
        { method: 'Bank/QR', amount: Number(bankQr.toFixed(2)) },
      ],
    };
  }, [completedSales, sales, reportDate]);

  const trendData = useMemo(() => {
    const days: { dateKey: string; label: string; revenue: number; profit: number }[] = [];
    const now = new Date();
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = getTodayDateKey(d);
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const matching = completedSales.filter((s) => s.dateKey === key);
      days.push({
        dateKey: key,
        label,
        revenue: Number(matching.reduce((a, s) => a + s.total, 0).toFixed(2)),
        profit: Number(matching.reduce((a, s) => a + s.profit, 0).toFixed(2)),
      });
    }
    return days;
  }, [completedSales, rangeDays]);

  const topProducts = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number; profit: number }>();
    for (const sale of completedSales) {
      for (const item of sale.items) {
        const cur = map.get(item.productId) ?? {
          name: item.name,
          qty: 0,
          revenue: 0,
          profit: 0,
        };
        cur.qty += item.quantity;
        cur.revenue += item.lineTotal;
        cur.profit += item.lineTotal - item.costPrice * item.quantity;
        map.set(item.productId, cur);
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);
  }, [completedSales]);

  const lowStockItems = useMemo(
    () => products.filter((p) => p.stock <= p.minStock).slice(0, 6),
    [products]
  );

  const staffReport = useMemo(() => {
    const map = new Map<
      string,
      { name: string; role: string; orders: number; voided: number; discounts: number; revenue: number }
    >();

    employees.forEach((emp) => {
      map.set(emp.id, {
        name: emp.name,
        role: emp.role,
        orders: 0,
        voided: 0,
        discounts: 0,
        revenue: 0,
      });
    });

    const daySales = sales.filter((s) => s.dateKey === reportDate);
    for (const s of daySales) {
      if (!s.employeeId && !s.employeeName) continue;
      const key = s.employeeId || `name_${s.employeeName}`;
      const existing = map.get(key) ?? {
        name: s.employeeName || 'Staff',
        role: 'Staff',
        orders: 0,
        voided: 0,
        discounts: 0,
        revenue: 0,
      };
      if (s.status === 'voided') {
        existing.voided += 1;
      } else {
        existing.orders += 1;
        existing.revenue += s.total;
        existing.discounts += s.discount;
      }
      map.set(key, existing);
    }

    return Array.from(map.values())
      .filter((r) => r.orders > 0 || r.voided > 0 || employees.length > 0)
      .sort((a, b) => b.revenue - a.revenue || b.voided - a.voided);
  }, [employees, sales, reportDate]);

  return (
    <div className="space-y-5">
      {/* Daily Summary Export & Date Controls */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Calendar className="w-4 h-4 text-slate-400" />
            <label htmlFor="report-date-picker">Daily Summary Date</label>
          </div>
          <input
            id="report-date-picker"
            type="date"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportDailySummaryCSV(store, reportDate, sales)}
            className="inline-flex items-center gap-2 rounded-lg brand-bg px-3.5 py-2 text-xs font-semibold text-white whitespace-nowrap cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Export Daily Summary CSV</span>
          </button>

          <button
            type="button"
            onClick={() =>
              onPrintJob({
                type: 'daily_report',
                dateKey: reportDate,
                sales,
                products,
              })
            }
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print Z-Report</span>
          </button>

          <button
            type="button"
            onClick={() => exportSalesLedgerCSV(store, sales)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>All Sales CSV</span>
          </button>

          <button
            type="button"
            onClick={() => exportInventoryCSV(store, products)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Stock CSV</span>
          </button>
        </div>
      </div>

      {/* 4-Column Owner KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Revenue ({reportDate})</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(dayStats.revenue, store.currency)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Tax: {formatMoney(dayStats.tax, store.currency)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Gross Profit</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
            {formatMoney(dayStats.profit, store.currency)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Margin: {dayStats.margin.toFixed(1)}%
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Orders Completed</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {dayStats.orders}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {dayStats.voidedCount} voided on this day
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Average Bill Size</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(dayStats.avgTicket, store.currency)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {lowStockItems.length} items need restock
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Revenue & Profit Trend
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Daily performance across completed bills
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {([7, 30] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setRangeDays(days)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                    rangeDays === days
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {days}D
                </button>
              ))}
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} width={64} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    borderColor: '#334155',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#f8fafc',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  name="Revenue"
                  stroke={store.primaryColor}
                  fill={store.primaryColor}
                  fillOpacity={0.14}
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="profit"
                  name="Profit"
                  stroke="#16a34a"
                  fill="#16a34a"
                  fillOpacity={0.1}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Payment Split ({reportDate})
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
            Cash drawer vs digital tenders
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dayStats.paymentChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} />
                <XAxis dataKey="method" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} width={58} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    borderColor: '#334155',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#f8fafc',
                  }}
                />
                <Bar dataKey="amount" name="Sales" fill={store.primaryColor} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom Tables: Top Sellers & Low Stock */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Top Selling Items (All-Time)
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                  <th className="py-2.5 px-4">Item</th>
                  <th className="py-2.5 px-4 text-right">Qty Sold</th>
                  <th className="py-2.5 px-4 text-right">Revenue</th>
                  <th className="py-2.5 px-4 text-right">Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {topProducts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500 dark:text-slate-400">
                      Complete sales to populate item rankings.
                    </td>
                  </tr>
                ) : (
                  topProducts.map((item) => (
                    <tr key={item.name}>
                      <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-slate-100">
                        {item.name}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {item.qty}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100">
                        {formatMoney(item.revenue, store.currency)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatMoney(item.profit, store.currency)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Low Stock Alerts
            </h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {lowStockItems.length === 0 ? (
              <div className="py-8 px-5 text-center text-slate-500 dark:text-slate-400">
                All items are stocked above their minimum threshold.
              </div>
            ) : (
              lowStockItems.map((p) => (
                <div key={p.id} className="px-5 py-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                      {p.name}
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {p.category} · Min {p.minStock} {p.unit}
                    </div>
                  </div>
                  <div
                    className={`font-mono font-semibold tabular-nums shrink-0 ${
                      p.stock <= 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {p.stock} {p.unit}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Staff Accountability & Performance Table (Selected Date) */}
      {staffReport.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Staff Accountability & Performance ({reportDate})
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Track handled orders, discounts granted, and voided bills per employee
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/40">
                  <th className="py-2.5 px-4">Employee</th>
                  <th className="py-2.5 px-4">Role</th>
                  <th className="py-2.5 px-4 text-right">Completed</th>
                  <th className="py-2.5 px-4 text-right">Voided</th>
                  <th className="py-2.5 px-4 text-right">Discounts</th>
                  <th className="py-2.5 px-4 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {staffReport.map((row) => (
                  <tr key={`${row.name}-${row.role}`}>
                    <td className="py-2.5 px-4 font-semibold text-slate-900 dark:text-slate-100">
                      {row.name}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400">{row.role}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                      {row.orders}
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-mono tabular-nums ${
                        row.voided > 0
                          ? 'text-red-600 dark:text-red-400 font-semibold'
                          : 'text-slate-400'
                      }`}
                    >
                      {row.voided}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {formatMoney(row.discounts, store.currency)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {formatMoney(row.revenue, store.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
