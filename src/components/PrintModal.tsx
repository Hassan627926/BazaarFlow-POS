import React, { useState } from 'react';
import { Printer, X } from 'lucide-react';
import type { PrintJob, StoreConfig } from '../types';
import { formatDateTime, formatMoney } from '../utils/posHelpers';
import { BarcodeSvg } from './BarcodeSvg';

interface PrintModalProps {
  job: PrintJob | null;
  store: StoreConfig;
  onClose: () => void;
}

export const PrintModal: React.FC<PrintModalProps> = ({ job, store, onClose }) => {
  const [paperWidth, setPaperWidth] = useState<'80mm' | '58mm'>('80mm');

  if (!job) return null;

  const handlePrint = () => {
    window.print();
  };

  const renderReceipt = (sale: Extract<PrintJob, { type: 'receipt' }>['sale']) => {
    const isNarrow = paperWidth === '58mm';
    return (
      <div
        className={`print-receipt-sheet mx-auto bg-white text-slate-950 border border-slate-200 rounded-lg p-5 font-mono text-xs leading-relaxed ${
          isNarrow ? 'max-w-[260px]' : 'max-w-[340px]'
        }`}
      >
        <div className="text-center border-b border-dashed border-slate-300 pb-3">
          {store.logoDataUrl && (
            <img
              src={store.logoDataUrl}
              alt={`${store.name} logo`}
              referrerPolicy="no-referrer"
              className="mx-auto mb-2 max-h-14 max-w-[140px] object-contain"
            />
          )}
          <div className="text-base font-bold font-display tracking-tight">{store.name}</div>
          {store.address && <div className="text-[11px] text-slate-600 mt-0.5">{store.address}</div>}
          {store.phone && <div className="text-[11px] text-slate-600">Tel: {store.phone}</div>}
        </div>

        <div className="py-2.5 border-b border-dashed border-slate-300 space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span>Invoice</span>
            <span className="font-semibold">{sale.invoiceNumber}</span>
          </div>
          <div className="flex justify-between">
            <span>Date</span>
            <span>{formatDateTime(sale.createdAt)}</span>
          </div>
          {store.businessType === 'restaurant' && (
            <div className="flex justify-between">
              <span>Order</span>
              <span className="font-semibold">
                {sale.orderType.replace('_', ' ').toUpperCase()}
                {sale.tableNumber ? ` · T-${sale.tableNumber}` : ''}
              </span>
            </div>
          )}
          {sale.customerName && (
            <div className="flex justify-between">
              <span>Customer</span>
              <span>{sale.customerName}</span>
            </div>
          )}
          {sale.status === 'voided' && (
            <div className="text-center font-bold text-red-700 pt-1">*** VOIDED RECEIPT ***</div>
          )}
        </div>

        <table className="w-full my-2.5 text-[11px]">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="pb-1 font-semibold">Item</th>
              <th className="pb-1 text-right font-semibold">Qty</th>
              <th className="pb-1 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dotted divide-slate-200">
            {sale.items.map((item, idx) => (
              <tr key={`${item.productId}-${idx}`}>
                <td className="py-1.5 pr-2">
                  <div className="font-medium text-slate-900">{item.name}</div>
                  <div className="text-[10px] text-slate-500">
                    @ {formatMoney(item.unitPrice, store.currency)}
                  </div>
                </td>
                <td className="py-1.5 text-right align-top tabular-nums">{item.quantity}</td>
                <td className="py-1.5 text-right align-top tabular-nums font-medium">
                  {formatMoney(item.lineTotal, store.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-t border-dashed border-slate-300 pt-2.5 space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span>Subtotal ({sale.itemCount} items)</span>
            <span className="tabular-nums">{formatMoney(sale.subtotal, store.currency)}</span>
          </div>
          {sale.discount > 0 && (
            <div className="flex justify-between">
              <span>Discount</span>
              <span className="tabular-nums">-{formatMoney(sale.discount, store.currency)}</span>
            </div>
          )}
          {sale.taxAmount > 0 && (
            <div className="flex justify-between">
              <span>Tax ({sale.taxRate}%)</span>
              <span className="tabular-nums">{formatMoney(sale.taxAmount, store.currency)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-300 pt-1.5 text-sm font-bold">
            <span>GRAND TOTAL</span>
            <span className="tabular-nums">{formatMoney(sale.total, store.currency)}</span>
          </div>
          <div className="flex justify-between pt-1">
            <span>Payment ({sale.paymentMethod.replace('_', '/').toUpperCase()})</span>
            <span className="tabular-nums">{formatMoney(sale.amountTendered, store.currency)}</span>
          </div>
          {sale.changeDue > 0 && (
            <div className="flex justify-between">
              <span>Change Due</span>
              <span className="tabular-nums">{formatMoney(sale.changeDue, store.currency)}</span>
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-dashed border-slate-300 pt-3 text-center text-[11px] text-slate-600">
          {store.receiptFooter || 'Thank you for your business!'}
        </div>
      </div>
    );
  };

  const renderKOT = (sale: Extract<PrintJob, { type: 'kot' }>['sale']) => (
    <div className="print-receipt-sheet mx-auto max-w-[320px] bg-white text-slate-950 border border-slate-200 rounded-lg p-5 font-mono text-xs">
      <div className="text-center border-b-2 border-slate-900 pb-2.5">
        <div className="text-xs font-semibold tracking-wider">KITCHEN ORDER TICKET</div>
        <div className="text-lg font-bold font-display mt-0.5">{store.name}</div>
      </div>

      <div className="py-3 border-b border-dashed border-slate-400 flex items-center justify-between text-sm font-bold">
        <span>{sale.orderType.replace('_', ' ').toUpperCase()}</span>
        <span>{sale.tableNumber ? `TABLE ${sale.tableNumber}` : 'COUNTER'}</span>
      </div>

      <div className="py-2 text-[11px] flex justify-between border-b border-dashed border-slate-300">
        <span>#{sale.invoiceNumber}</span>
        <span>{formatDateTime(sale.createdAt)}</span>
      </div>

      <div className="py-3 space-y-2">
        {sale.items.map((item, idx) => (
          <div key={`${item.productId}-${idx}`} className="flex items-start justify-between text-sm">
            <span className="font-bold pr-3 tabular-nums">{item.quantity}x</span>
            <span className="flex-1 font-medium">{item.name}</span>
          </div>
        ))}
      </div>

      {sale.customerName && (
        <div className="border-t border-dashed border-slate-300 pt-2 text-[11px]">
          Guest / Note: {sale.customerName}
        </div>
      )}
    </div>
  );

  const renderBarcodeSheet = (labels: Extract<PrintJob, { type: 'barcodes' }>['labels']) => {
    const expanded = labels.flatMap(({ product, copies }) =>
      Array.from({ length: Math.min(Math.max(copies, 1), 60) }, (_, idx) => ({
        key: `${product.id}-${idx}`,
        product,
      }))
    );

    return (
      <div className="print-full-sheet bg-white text-slate-950 p-4 rounded-lg border border-slate-200">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {expanded.map(({ key, product }) => (
            <div
              key={key}
              className="border border-dashed border-slate-300 rounded p-2.5 flex flex-col items-center text-center break-inside-avoid"
            >
              <div className="text-[10px] font-semibold text-slate-600 truncate w-full">
                {store.name}
              </div>
              <div className="text-xs font-semibold text-slate-950 truncate w-full mt-0.5">
                {product.name}
              </div>
              <div className="my-1.5 flex justify-center w-full">
                <BarcodeSvg value={product.barcode} height={38} width={1.35} fontSize={10} />
              </div>
              <div className="text-xs font-bold font-mono tabular-nums text-slate-950">
                {formatMoney(product.sellingPrice, store.currency)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderDailyReport = (
    dateKey: string,
    sales: Extract<PrintJob, { type: 'daily_report' }>['sales'],
    products: Extract<PrintJob, { type: 'daily_report' }>['products']
  ) => {
    const daySales = sales.filter((s) => s.dateKey === dateKey);
    const completed = daySales.filter((s) => s.status === 'completed');
    const voided = daySales.filter((s) => s.status === 'voided');

    const grossRevenue = completed.reduce((acc, s) => acc + s.total, 0);
    const totalCost = completed.reduce((acc, s) => acc + s.totalCost, 0);
    const netProfit = completed.reduce((acc, s) => acc + s.profit, 0);
    const totalTax = completed.reduce((acc, s) => acc + s.taxAmount, 0);
    const totalDiscount = completed.reduce((acc, s) => acc + s.discount, 0);
    const cashSales = completed.filter((s) => s.paymentMethod === 'cash').reduce((a, s) => a + s.total, 0);
    const cardSales = completed.filter((s) => s.paymentMethod === 'card').reduce((a, s) => a + s.total, 0);
    const qrSales = completed.filter((s) => s.paymentMethod === 'bank_qr').reduce((a, s) => a + s.total, 0);
    const lowStockCount = products.filter((p) => p.stock <= p.minStock).length;

    return (
      <div className="print-full-sheet bg-white text-slate-950 border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex items-start justify-between border-b border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            {store.logoDataUrl && (
              <img
                src={store.logoDataUrl}
                alt={store.name}
                referrerPolicy="no-referrer"
                className="w-12 h-12 object-contain"
              />
            )}
            <div>
              <h2 className="text-xl font-bold font-display">{store.name}</h2>
              <p className="text-xs text-slate-600">
                Owner Daily Summary Report (Z-Report) · {dateKey}
              </p>
            </div>
          </div>
          <div className="text-right text-xs text-slate-600 font-mono">
            <div>Generated: {new Date().toLocaleDateString()}</div>
            <div>Mode: {store.businessType === 'retail' ? 'Retail Shop' : 'Restaurant'}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="border border-slate-200 rounded-lg p-3">
            <div className="text-xs text-slate-500">Gross Revenue</div>
            <div className="text-lg font-bold font-mono tabular-nums mt-1">
              {formatMoney(grossRevenue, store.currency)}
            </div>
          </div>
          <div className="border border-slate-200 rounded-lg p-3">
            <div className="text-xs text-slate-500">Gross Profit</div>
            <div className="text-lg font-bold font-mono tabular-nums mt-1">
              {formatMoney(netProfit, store.currency)}
            </div>
          </div>
          <div className="border border-slate-200 rounded-lg p-3">
            <div className="text-xs text-slate-500">Completed Orders</div>
            <div className="text-lg font-bold font-mono tabular-nums mt-1">
              {completed.length}{' '}
              <span className="text-xs font-normal text-slate-500">({voided.length} void)</span>
            </div>
          </div>
          <div className="border border-slate-200 rounded-lg p-3">
            <div className="text-xs text-slate-500">Low Stock SKUs</div>
            <div className="text-lg font-bold font-mono tabular-nums mt-1">{lowStockCount}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="border border-slate-200 rounded-lg p-4 space-y-2">
            <div className="font-semibold text-sm text-slate-900">Payment Tender Breakdown</div>
            <div className="flex justify-between">
              <span>Cash Drawer</span>
              <span className="font-mono tabular-nums">{formatMoney(cashSales, store.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span>Card Terminal</span>
              <span className="font-mono tabular-nums">{formatMoney(cardSales, store.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span>Bank Transfer / QR</span>
              <span className="font-mono tabular-nums">{formatMoney(qrSales, store.currency)}</span>
            </div>
          </div>

          <div className="border border-slate-200 rounded-lg p-4 space-y-2">
            <div className="font-semibold text-sm text-slate-900">Financial Adjustments</div>
            <div className="flex justify-between">
              <span>Cost of Goods Sold (COGS)</span>
              <span className="font-mono tabular-nums">{formatMoney(totalCost, store.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span>Sales Tax Collected</span>
              <span className="font-mono tabular-nums">{formatMoney(totalTax, store.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span>Discounts Granted</span>
              <span className="font-mono tabular-nums">{formatMoney(totalDiscount, store.currency)}</span>
            </div>
          </div>
        </div>

        <div>
          <div className="font-semibold text-sm text-slate-900 mb-2">
            Transactions on {dateKey} ({daySales.length})
          </div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-600">
                <th className="py-1.5">Invoice</th>
                <th className="py-1.5">Payment</th>
                <th className="py-1.5">Status</th>
                <th className="py-1.5 text-right">Items</th>
                <th className="py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {daySales.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-500">
                    No sales recorded on this date.
                  </td>
                </tr>
              ) : (
                daySales.map((s) => (
                  <tr key={s.id}>
                    <td className="py-1.5 font-mono">{s.invoiceNumber}</td>
                    <td className="py-1.5 uppercase">{s.paymentMethod.replace('_', '/')}</td>
                    <td className="py-1.5 capitalize">{s.status}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{s.itemCount}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums font-medium">
                      {formatMoney(s.total, store.currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/70 backdrop-blur-xs p-4 overflow-y-auto print:static print:inset-auto print:bg-white print:p-0 print:block print:overflow-visible"
      role="dialog"
      aria-modal="true"
    >
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 shadow-2xl overflow-hidden my-auto print:max-w-none print:border-none print:shadow-none print:rounded-none print:bg-white print:overflow-visible print:my-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-3.5 no-print">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {job.type === 'receipt' && 'Print Sales Bill'}
              {job.type === 'kot' && 'Kitchen Order Ticket (KOT)'}
              {job.type === 'barcodes' && 'Print Retail Barcode Labels'}
              {job.type === 'daily_report' && `Daily Summary Z-Report · ${job.dateKey}`}
            </h3>
            {job.type === 'receipt' && (
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
                {(['80mm', '58mm'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setPaperWidth(w)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      paperWidth === w
                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-2 rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              <span>Print / Save PDF</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
              aria-label="Close print preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 max-h-[78vh] overflow-y-auto print:max-h-none print:overflow-visible print:p-0">
          {job.type === 'receipt' && renderReceipt(job.sale)}
          {job.type === 'kot' && renderKOT(job.sale)}
          {job.type === 'barcodes' && renderBarcodeSheet(job.labels)}
          {job.type === 'daily_report' && renderDailyReport(job.dateKey, job.sales, job.products)}
        </div>
      </div>
    </div>
  );
};
