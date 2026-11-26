import React, { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, MessageCircle, Printer, X } from 'lucide-react';
import type { PrintJob, Sale, StoreConfig } from '../types';
import { formatDateTime, formatMoney, isProductStockTracked } from '../utils/posHelpers';
import { generateReceiptPdfFile, triggerPdfDownload } from '../utils/receiptPdf';
import { BarcodeSvg } from './BarcodeSvg';

interface PrintModalProps {
  job: PrintJob | null;
  store: StoreConfig;
  onClose: () => void;
  onMarkKotPrinted?: (kotId: string) => void;
}

function formatWhatsAppNumber(raw: string, currency: string): string {
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  // Auto-prepend Pakistan country code for 11-digit local mobile numbers (03XXXXXXXXX) when store uses PKR
  if (currency.toUpperCase() === 'PKR' && digits.length === 11 && digits.startsWith('03')) {
    digits = `92${digits.slice(1)}`;
  }
  return digits;
}

function buildWhatsAppReceiptText(sale: Sale, store: StoreConfig, isProforma = false): string {
  const lines: string[] = [];
  lines.push(`*${store.name}*`);
  if (store.address) lines.push(store.address);
  if (store.phone) lines.push(`Tel: ${store.phone}`);
  lines.push('────────────────────');
  if (isProforma) {
    lines.push('*CUSTOMER BILL (UNPAID)*');
  }
  lines.push(`*${isProforma ? 'Bill Ref' : 'Invoice'}:* ${sale.invoiceNumber}`);
  lines.push(`*Date:* ${formatDateTime(sale.createdAt)}`);
  if (store.businessType === 'restaurant') {
    const orderLabel = sale.orderType.replace('_', ' ').toUpperCase();
    lines.push(`*Order:* ${orderLabel}${sale.tableNumber ? ` · Table ${sale.tableNumber}` : ''}`);
  }
  if (sale.employeeName) lines.push(`*Staff:* ${sale.employeeName}`);
  if (sale.customerName) lines.push(`*Customer:* ${sale.customerName}`);
  if (sale.customerPhone) lines.push(`*Phone:* ${sale.customerPhone}`);
  if (sale.customerAddress) lines.push(`*Address:* ${sale.customerAddress}`);
  if (!isProforma && sale.status === 'voided') lines.push('*STATUS: VOIDED RECEIPT*');
  lines.push('────────────────────');
  lines.push('*Items:*');
  sale.items.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.name}`);
    lines.push(
      `   ${item.quantity} × ${formatMoney(item.unitPrice, store.currency)} = ${formatMoney(
        item.lineTotal,
        store.currency
      )}`
    );
  });
  lines.push('────────────────────');
  lines.push(`Subtotal (${sale.itemCount} items): ${formatMoney(sale.subtotal, store.currency)}`);
  lines.push(`Tax (${sale.taxRate ?? 0}%): ${formatMoney(sale.taxAmount ?? 0, store.currency)}`);
  if (sale.discount > 0) {
    lines.push(`Discount: -${formatMoney(sale.discount, store.currency)}`);
  }
  lines.push(`*${isProforma ? 'TOTAL PAYABLE' : 'GRAND TOTAL'}: ${formatMoney(sale.total, store.currency)}*`);
  if (!isProforma) {
    if (sale.paymentMethod === 'cash') {
      lines.push(`Cash Received: ${formatMoney(sale.amountTendered, store.currency)}`);
      lines.push(`*Change / Return: ${formatMoney(sale.changeDue ?? 0, store.currency)}*`);
    } else {
      lines.push(
        `Payment (${sale.paymentMethod.replace('_', '/').toUpperCase()}): ${formatMoney(
          sale.amountTendered,
          store.currency
        )}`
      );
    }
  } else {
    lines.push('_Payment Pending_');
  }
  lines.push('────────────────────');
  lines.push(store.receiptFooter || 'Thank you for your business!');
  return lines.join('\n');
}

export const PrintModal: React.FC<PrintModalProps> = ({
  job,
  store,
  onClose,
  onMarkKotPrinted,
}) => {
  const [paperWidth, setPaperWidth] = useState<'80mm' | '58mm'>('80mm');
  const [whatsappPhone, setWhatsappPhone] = useState<string>('');
  const [pdfBusy, setPdfBusy] = useState<boolean>(false);
  const [pdfNotice, setPdfNotice] = useState<{ filename: string; mode: 'shared' | 'downloaded' } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const autoPrintedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (job && job.type === 'receipt') {
      setWhatsappPhone(job.sale.customerPhone || '');
      setPdfNotice(null);
      setPdfError(null);
    }
  }, [job]);

  // Automatic print trigger for dedicated Counter/Kitchen KOT Auto-Print station
  useEffect(() => {
    if (!job || job.type !== 'kot' || !job.autoPrint) {
      autoPrintedKeyRef.current = null;
      return;
    }
    const key = job.kotId || job.sale.id;
    if (autoPrintedKeyRef.current === key) return;
    autoPrintedKeyRef.current = key;

    const handleAfterPrint = () => {
      if (job.kotId && onMarkKotPrinted) {
        onMarkKotPrinted(job.kotId);
      }
      onClose();
    };

    window.addEventListener('afterprint', handleAfterPrint);
    const timer = window.setTimeout(() => {
      if (job.kotId && onMarkKotPrinted) {
        onMarkKotPrinted(job.kotId);
      }
      window.print();
    }, 240);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, [job, onClose, onMarkKotPrinted]);

  if (!job) return null;

  const handlePrint = () => {
    if (job.type === 'kot' && job.kotId && onMarkKotPrinted) {
      onMarkKotPrinted(job.kotId);
    }
    window.print();
  };

  const isProformaReceipt = job.type === 'receipt' && !!job.isProforma;

  const receiptWhatsAppText =
    job.type === 'receipt' ? buildWhatsAppReceiptText(job.sale, store, isProformaReceipt) : '';
  const formattedWaDigits =
    job.type === 'receipt' ? formatWhatsAppNumber(whatsappPhone, store.currency) : '';
  const whatsappTextUrl =
    job.type === 'receipt'
      ? `https://wa.me/${formattedWaDigits}?text=${encodeURIComponent(receiptWhatsAppText)}`
      : '';
  const whatsappPdfCaption =
    job.type === 'receipt'
      ? `${isProformaReceipt ? 'Customer Bill (Unpaid)' : 'Bill'} ${job.sale.invoiceNumber} from ${
          store.name
        } — ${isProformaReceipt ? 'Total Payable' : 'Grand Total'}: ${formatMoney(
          job.sale.total,
          store.currency
        )}. Please find the attached PDF bill.`
      : '';
  const whatsappPdfChatUrl =
    job.type === 'receipt'
      ? `https://wa.me/${formattedWaDigits}?text=${encodeURIComponent(whatsappPdfCaption)}`
      : '';

  const handleDownloadPdf = async () => {
    if (job.type !== 'receipt') return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const { blob, filename } = await generateReceiptPdfFile(
        job.sale,
        store,
        paperWidth,
        isProformaReceipt
      );
      triggerPdfDownload(blob, filename);
      setPdfNotice({ filename, mode: 'downloaded' });
    } catch {
      setPdfError('Could not generate PDF bill. Please try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleSharePdfWhatsApp = async () => {
    if (job.type !== 'receipt') return;
    setPdfBusy(true);
    setPdfError(null);
    setPdfNotice(null);

    try {
      const { blob, file, filename } = await generateReceiptPdfFile(
        job.sale,
        store,
        paperWidth,
        isProformaReceipt
      );

      // On Mobile (Android / iOS) & Web Share File-capable devices, share the real .pdf file directly to WhatsApp
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
      };
      if (typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
        try {
          await nav.share({
            files: [file],
            title: `${store.name} — Bill ${job.sale.invoiceNumber}`,
            text: whatsappPdfCaption,
          });
          setPdfNotice({ filename, mode: 'shared' });
          return;
        } catch (shareErr) {
          // If user simply closed the share sheet, do not treat as failure
          if (shareErr instanceof Error && shareErr.name === 'AbortError') {
            return;
          }
          // Otherwise (e.g. iframe restriction or desktop browser), fall through to instant PDF download + WhatsApp chat link
        }
      }

      // Desktop / browser fallback: download the real PDF immediately and display 1-click Open WhatsApp Chat button
      triggerPdfDownload(blob, filename);
      setPdfNotice({ filename, mode: 'downloaded' });
    } catch {
      setPdfError('Could not prepare PDF bill. Please try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const renderReceipt = (
    sale: Extract<PrintJob, { type: 'receipt' }>['sale'],
    isProforma = false
  ) => {
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
          {isProforma && (
            <div className="mt-2 py-1 border-y border-slate-900 text-[11px] font-bold tracking-wider uppercase">
              CUSTOMER BILL (UNPAID)
            </div>
          )}
        </div>

        <div className="py-2.5 border-b border-dashed border-slate-300 space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span>{isProforma ? 'Bill Ref' : 'Invoice'}</span>
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
          {sale.employeeName && (
            <div className="flex justify-between gap-2">
              <span>Staff</span>
              <span className="text-right font-semibold">{sale.employeeName}</span>
            </div>
          )}
          {sale.customerName && (
            <div className="flex justify-between gap-2">
              <span>Customer</span>
              <span className="text-right font-medium">{sale.customerName}</span>
            </div>
          )}
          {sale.customerPhone && (
            <div className="flex justify-between gap-2">
              <span>Phone</span>
              <span className="text-right">{sale.customerPhone}</span>
            </div>
          )}
          {sale.customerAddress && (
            <div className="flex justify-between gap-2">
              <span className="shrink-0">Address</span>
              <span className="text-right">{sale.customerAddress}</span>
            </div>
          )}
          {!isProforma && sale.status === 'voided' && (
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
          <div className="flex justify-between">
            <span>Tax ({sale.taxRate ?? 0}%)</span>
            <span className="tabular-nums">{formatMoney(sale.taxAmount ?? 0, store.currency)}</span>
          </div>
          {sale.discount > 0 && (
            <div className="flex justify-between">
              <span>Discount</span>
              <span className="tabular-nums">-{formatMoney(sale.discount, store.currency)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-300 pt-1.5 text-sm font-bold">
            <span>{isProforma ? 'TOTAL PAYABLE' : 'GRAND TOTAL'}</span>
            <span className="tabular-nums">{formatMoney(sale.total, store.currency)}</span>
          </div>
          {isProforma ? (
            <div className="pt-1.5 text-center text-[11px] font-semibold text-slate-700">
              Payment Pending — Please pay at table or counter
            </div>
          ) : sale.paymentMethod === 'cash' ? (
            <>
              <div className="flex justify-between pt-1">
                <span>Cash Received</span>
                <span className="tabular-nums font-medium">
                  {formatMoney(sale.amountTendered, store.currency)}
                </span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Change / Return</span>
                <span className="tabular-nums">
                  {formatMoney(sale.changeDue ?? 0, store.currency)}
                </span>
              </div>
            </>
          ) : (
            <div className="flex justify-between pt-1">
              <span>Payment ({sale.paymentMethod.replace('_', '/').toUpperCase()})</span>
              <span className="tabular-nums">{formatMoney(sale.amountTendered, store.currency)}</span>
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-dashed border-slate-300 pt-3 text-center text-[11px] text-slate-600">
          {store.receiptFooter || 'Thank you for your business!'}
        </div>
      </div>
    );
  };

  const renderKOT = (
    sale: Extract<PrintJob, { type: 'kot' }>['sale'],
    isAddOn?: boolean,
    isRevised?: boolean,
    changeNotes?: string[]
  ) => (
    <div className="print-receipt-sheet mx-auto max-w-[320px] bg-white text-slate-950 border border-slate-200 rounded-lg p-5 font-mono text-xs">
      <div className="text-center border-b-2 border-slate-900 pb-2.5">
        <div className="text-xs font-semibold tracking-wider">
          {isRevised
            ? 'REVISED KITCHEN ORDER TICKET'
            : isAddOn
            ? 'ADD-ON KITCHEN ORDER TICKET'
            : 'KITCHEN ORDER TICKET'}
        </div>
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

      {isRevised && changeNotes && changeNotes.length > 0 && (
        <div className="py-2.5 border-b border-dashed border-slate-400 space-y-1">
          <div className="text-[11px] font-bold uppercase tracking-wide">Changes Made:</div>
          {changeNotes.map((note, idx) => (
            <div key={idx} className="text-xs font-bold">
              {note}
            </div>
          ))}
        </div>
      )}

      <div className="py-3 space-y-2">
        {isRevised && (
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
            Updated Table Order:
          </div>
        )}
        {sale.items.map((item, idx) => (
          <div key={`${item.productId}-${idx}`} className="flex items-start justify-between text-sm">
            <span className="font-bold pr-3 tabular-nums">{item.quantity}x</span>
            <span className="flex-1 font-medium">{item.name}</span>
          </div>
        ))}
      </div>

      {(sale.employeeName || sale.customerName || sale.customerPhone || sale.customerAddress) && (
        <div className="border-t border-dashed border-slate-300 pt-2 space-y-0.5 text-[11px]">
          {sale.employeeName && <div className="font-bold">Staff: {sale.employeeName}</div>}
          {sale.customerName && <div>Customer: {sale.customerName}</div>}
          {sale.customerPhone && <div>Phone: {sale.customerPhone}</div>}
          {sale.customerAddress && <div>Address: {sale.customerAddress}</div>}
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
    const lowStockCount = products.filter(
      (p) => isProductStockTracked(p) && p.stock <= p.minStock
    ).length;

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
              {job.type === 'receipt' &&
                (job.isProforma ? 'Customer Bill (Unpaid)' : 'Print Sales Bill')}
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
              <span>
                {job.type === 'kot'
                  ? 'Print KOT'
                  : job.type === 'receipt'
                  ? 'Print Bill'
                  : job.type === 'barcodes'
                  ? 'Print Labels'
                  : 'Print Report'}
              </span>
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

        {/* WhatsApp PDF Bill Share Bar (Receipt Print Screen Only) */}
        {job.type === 'receipt' && (
          <div className="border-b border-slate-200 dark:border-slate-800 bg-emerald-50/70 dark:bg-emerald-950/25 px-5 py-3 space-y-2.5 no-print">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                <MessageCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <input
                  type="tel"
                  value={whatsappPhone}
                  onChange={(e) => setWhatsappPhone(e.target.value)}
                  placeholder="Customer WhatsApp # (e.g. 03001234567 — optional)"
                  aria-label="Customer WhatsApp Number"
                  className="w-full rounded-lg border border-emerald-200 dark:border-emerald-800/80 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder:font-sans placeholder:text-slate-400"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => void handleSharePdfWhatsApp()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white whitespace-nowrap disabled:opacity-60 transition-colors cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Creating PDF...' : 'Share PDF on WhatsApp'}</span>
                </button>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => void handleDownloadPdf()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                  title="Download thermal PDF bill"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download PDF</span>
                </button>
                <a
                  href={whatsappTextUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 hover:underline whitespace-nowrap"
                  title="Send plain text bill on WhatsApp"
                >
                  <span>Text Bill</span>
                </a>
              </div>
            </div>

            {pdfNotice && pdfNotice.mode === 'downloaded' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs">
                <div className="text-slate-700 dark:text-slate-200 min-w-0">
                  PDF saved (<span className="font-mono font-semibold">{pdfNotice.filename}</span>) — open
                  WhatsApp and attach/drop this PDF file.
                </div>
                <a
                  href={whatsappPdfChatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open WhatsApp Chat</span>
                </a>
              </div>
            )}

            {pdfNotice && pdfNotice.mode === 'shared' && (
              <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
                PDF bill ({pdfNotice.filename}) shared successfully.
              </div>
            )}

            {pdfError && (
              <div className="text-xs font-medium text-red-600 dark:text-red-400">{pdfError}</div>
            )}
          </div>
        )}

        <div className="p-5 max-h-[78vh] overflow-y-auto print:max-h-none print:overflow-visible print:p-0">
          {job.type === 'receipt' && renderReceipt(job.sale, isProformaReceipt)}
          {job.type === 'kot' && renderKOT(job.sale, job.isAddOn, job.isRevised, job.changeNotes)}
          {job.type === 'barcodes' && renderBarcodeSheet(job.labels)}
          {job.type === 'daily_report' && renderDailyReport(job.dateKey, job.sales, job.products)}
        </div>
      </div>
    </div>
  );
};
