import { jsPDF } from 'jspdf';
import type { Sale, StoreConfig } from '../types';
import {
  formatDailyToken,
  formatDateTime,
  formatMoney,
  getSaleTenderBreakdown,
} from './posHelpers';

function loadImageDimensions(
  dataUrl: string
): Promise<{ width: number; height: number; format: 'PNG' | 'JPEG' | 'WEBP' } | null> {
  return new Promise((resolve) => {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      resolve(null);
      return;
    }
    const format: 'PNG' | 'JPEG' | 'WEBP' = dataUrl.includes('image/jpeg') || dataUrl.includes('image/jpg')
      ? 'JPEG'
      : dataUrl.includes('image/webp')
      ? 'WEBP'
      : 'PNG';

    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight, format });
      } else {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function renderReceiptIntoDoc(
  doc: jsPDF,
  sale: Sale,
  store: StoreConfig,
  pageWidth: number,
  logoMeta: { width: number; height: number; format: 'PNG' | 'JPEG' | 'WEBP' } | null,
  dryRun: boolean,
  isProforma = false
): number {
  const isNarrow = pageWidth <= 60;
  const margin = isNarrow ? 3.5 : 5;
  const contentWidth = pageWidth - margin * 2;
  const centerX = pageWidth / 2;
  const rightX = pageWidth - margin;

  const baseFont = isNarrow ? 7.5 : 8.5;
  const smallFont = isNarrow ? 6.5 : 7.5;
  const titleFont = isNarrow ? 10.5 : 12;
  const lineH = isNarrow ? 3.5 : 4.1;

  let y = 5;

  const drawDashedDivider = () => {
    y += 1.5;
    if (!dryRun) {
      doc.setDrawColor(150);
      doc.setLineWidth(0.2);
      doc.setLineDashPattern([1, 1], 0);
      doc.line(margin, y, rightX, y);
      doc.setLineDashPattern([], 0);
    }
    y += 3.2;
  };

  const drawSolidDivider = () => {
    y += 1.2;
    if (!dryRun) {
      doc.setDrawColor(60);
      doc.setLineWidth(0.3);
      doc.line(margin, y, rightX, y);
    }
    y += 3.6;
  };

  const drawKeyValue = (label: string, value: string, bold = false, fontSize = smallFont) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(fontSize);
    const maxValW = contentWidth * 0.62;
    const wrappedVal = doc.splitTextToSize(value, maxValW) as string[];
    if (!dryRun) {
      doc.text(label, margin, y);
      wrappedVal.forEach((line, idx) => {
        doc.text(line, rightX, y + idx * (lineH - 0.3), { align: 'right' });
      });
    }
    y += Math.max(1, wrappedVal.length) * (lineH - 0.3) + 0.6;
  };

  // Optional Store Logo
  if (logoMeta && store.logoDataUrl) {
    const maxW = isNarrow ? 22 : 28;
    const maxH = 14;
    const ratio = Math.min(maxW / logoMeta.width, maxH / logoMeta.height);
    const drawW = logoMeta.width * ratio;
    const drawH = logoMeta.height * ratio;
    if (!dryRun) {
      try {
        doc.addImage(store.logoDataUrl, logoMeta.format, centerX - drawW / 2, y, drawW, drawH);
      } catch {
        // Skip unsupported image formats safely
      }
    }
    y += drawH + 2.5;
  }

  // Store Header
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(titleFont);
  const nameLines = doc.splitTextToSize(store.name, contentWidth) as string[];
  nameLines.forEach((line) => {
    if (!dryRun) doc.text(line, centerX, y, { align: 'center' });
    y += lineH + 0.5;
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(smallFont);
  doc.setTextColor(71, 85, 105);

  if (store.address) {
    const addrLines = doc.splitTextToSize(store.address, contentWidth) as string[];
    addrLines.forEach((line) => {
      if (!dryRun) doc.text(line, centerX, y, { align: 'center' });
      y += lineH - 0.5;
    });
  }
  if (store.phone) {
    if (!dryRun) doc.text(`Tel: ${store.phone}`, centerX, y, { align: 'center' });
    y += lineH - 0.4;
  }

  doc.setTextColor(15, 23, 42);
  drawDashedDivider();

  // Invoice & Order Metadata
  if (isProforma) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(baseFont);
    if (!dryRun) {
      doc.setTextColor(15, 23, 42);
      doc.text('*** CUSTOMER BILL (UNPAID) ***', centerX, y + 0.5, { align: 'center' });
    }
    y += lineH + 1;
  }
  drawKeyValue(isProforma ? 'Bill Ref' : 'Invoice', sale.invoiceNumber, true);
  drawKeyValue('Date', formatDateTime(sale.createdAt));

  if (store.businessType === 'restaurant') {
    const tokenLabel = formatDailyToken(sale.tokenNumber);
    if (tokenLabel) {
      drawKeyValue('Daily Token', tokenLabel, true, baseFont);
    }
    const orderText = `${sale.orderType.replace('_', ' ').toUpperCase()}${
      sale.tableNumber ? ` · T-${sale.tableNumber}` : ''
    }`;
    drawKeyValue('Order', orderText, true);
  }
  if (sale.employeeName) {
    drawKeyValue('Staff', sale.employeeName, true);
  }
  if (sale.customerName) {
    drawKeyValue('Customer', sale.customerName);
  }
  if (sale.customerPhone) {
    drawKeyValue('Phone', sale.customerPhone);
  }
  if (sale.customerAddress) {
    drawKeyValue('Address', sale.customerAddress);
  }
  if (!isProforma && sale.status === 'voided') {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(baseFont);
    if (!dryRun) {
      doc.setTextColor(185, 28, 28);
      doc.text('*** VOIDED RECEIPT ***', centerX, y + 1, { align: 'center' });
      doc.setTextColor(15, 23, 42);
    }
    y += lineH + 1;
  }

  drawDashedDivider();

  // Items Header
  const qtyColX = rightX - (isNarrow ? 17 : 22);
  const itemColW = qtyColX - margin - 4;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(smallFont);
  if (!dryRun) {
    doc.text('Item', margin, y);
    doc.text('Qty', qtyColX, y, { align: 'right' });
    doc.text('Total', rightX, y, { align: 'right' });
  }
  y += 1.6;
  if (!dryRun) {
    doc.setDrawColor(120);
    doc.setLineWidth(0.25);
    doc.line(margin, y, rightX, y);
  }
  y += 3.2;

  // Line Items
  sale.items.forEach((item) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(smallFont);
    const wrappedName = doc.splitTextToSize(item.name, itemColW) as string[];
    if (!dryRun) {
      doc.setTextColor(15, 23, 42);
      wrappedName.forEach((line, idx) => {
        doc.text(line, margin, y + idx * (lineH - 0.5));
      });
      doc.setFont('helvetica', 'normal');
      doc.text(String(item.quantity), qtyColX, y, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(formatMoney(item.lineTotal, store.currency), rightX, y, { align: 'right' });
    }
    y += wrappedName.length * (lineH - 0.5);

    if (item.note) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(smallFont - 0.6);
      const noteLines = doc.splitTextToSize(`Note: ${item.note}`, itemColW) as string[];
      if (!dryRun) {
        doc.setTextColor(71, 85, 105);
        noteLines.forEach((line, idx) => {
          doc.text(line, margin, y + idx * (lineH - 0.6));
        });
      }
      y += noteLines.length * (lineH - 0.6);
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(smallFont - 0.8);
    if (!dryRun) {
      doc.setTextColor(100, 116, 139);
      doc.text(`@ ${formatMoney(item.unitPrice, store.currency)}`, margin, y);
      doc.setTextColor(15, 23, 42);
    }
    y += lineH - 0.2;
  });

  drawDashedDivider();

  // Totals Breakdown (Subtotal -> Discount -> Service Charge -> Delivery Fee -> Tax -> Grand Total)
  drawKeyValue(
    `Subtotal (${sale.itemCount} items)`,
    formatMoney(sale.subtotal, store.currency),
    false,
    baseFont
  );
  if (sale.discount > 0) {
    drawKeyValue(
      'Discount',
      `-${formatMoney(sale.discount, store.currency)}`,
      false,
      baseFont
    );
  }
  if ((sale.serviceChargeAmount ?? 0) > 0) {
    drawKeyValue(
      `Service Charge (${sale.serviceChargeRate ?? 0}%)`,
      formatMoney(sale.serviceChargeAmount ?? 0, store.currency),
      false,
      baseFont
    );
  }
  if ((sale.deliveryFee ?? 0) > 0) {
    drawKeyValue(
      'Delivery Fee',
      formatMoney(sale.deliveryFee ?? 0, store.currency),
      false,
      baseFont
    );
  }
  drawKeyValue(
    `Tax (${sale.taxRate ?? 0}%)`,
    formatMoney(sale.taxAmount ?? 0, store.currency),
    false,
    baseFont
  );

  drawSolidDivider();

  drawKeyValue(
    isProforma ? 'TOTAL PAYABLE' : 'GRAND TOTAL',
    formatMoney(sale.total, store.currency),
    true,
    isNarrow ? 9.5 : 10.5
  );
  y += 1;

  // Payment, Cash Received & Change / Return (omitted on unpaid pre-payment bills)
  if (!isProforma) {
    if (sale.paymentMethod === 'split' && sale.paymentSplit) {
      const split = getSaleTenderBreakdown(sale);
      drawKeyValue('Payment Method', 'SPLIT (MIX)', true, baseFont);
      if (split.cash > 0) {
        drawKeyValue(
          (sale.changeDue ?? 0) > 0 ? 'Cash Applied' : 'Cash',
          formatMoney(split.cash, store.currency),
          false,
          baseFont
        );
        if ((sale.changeDue ?? 0) > 0) {
          drawKeyValue(
            'Cash Received',
            formatMoney(split.cash + (sale.changeDue ?? 0), store.currency),
            false,
            baseFont
          );
          drawKeyValue(
            'Change / Return',
            formatMoney(sale.changeDue ?? 0, store.currency),
            true,
            baseFont
          );
        }
      }
      if (split.card > 0) {
        drawKeyValue('Card', formatMoney(split.card, store.currency), false, baseFont);
      }
      if (split.bank_qr > 0) {
        drawKeyValue('Bank / QR', formatMoney(split.bank_qr, store.currency), false, baseFont);
      }
    } else if (sale.paymentMethod === 'cash') {
      drawKeyValue(
        'Cash Received',
        formatMoney(sale.amountTendered, store.currency),
        false,
        baseFont
      );
      drawKeyValue(
        'Change / Return',
        formatMoney(sale.changeDue ?? 0, store.currency),
        true,
        baseFont
      );
    } else {
      drawKeyValue(
        `Payment (${sale.paymentMethod.replace('_', '/').toUpperCase()})`,
        formatMoney(sale.amountTendered, store.currency),
        false,
        baseFont
      );
    }
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(smallFont);
    if (!dryRun) {
      doc.text('Payment Pending — Please pay at table or counter', centerX, y + 0.5, { align: 'center' });
    }
    y += lineH;
  }

  drawDashedDivider();

  // Footer
  const footer = store.receiptFooter || 'Thank you for your business!';
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(smallFont);
  doc.setTextColor(71, 85, 105);
  const footerLines = doc.splitTextToSize(footer, contentWidth) as string[];
  footerLines.forEach((line) => {
    if (!dryRun) doc.text(line, centerX, y, { align: 'center' });
    y += lineH - 0.4;
  });

  return y + 4;
}

export async function generateReceiptPdfFile(
  sale: Sale,
  store: StoreConfig,
  paperWidth: '80mm' | '58mm',
  isProforma = false
): Promise<{ blob: Blob; file: File; filename: string }> {
  const widthMm = paperWidth === '58mm' ? 58 : 80;
  const logoMeta = store.logoDataUrl ? await loadImageDimensions(store.logoDataUrl) : null;

  // First pass: measure exact receipt height dynamically
  const measureDoc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [widthMm, 260],
  });
  const totalHeight = Math.max(
    80,
    Math.ceil(renderReceiptIntoDoc(measureDoc, sale, store, widthMm, logoMeta, true, isProforma))
  );

  // Second pass: render crisp vector PDF at exact receipt height
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [widthMm, totalHeight],
  });
  renderReceiptIntoDoc(pdf, sale, store, widthMm, logoMeta, false, isProforma);

  const safeInv = sale.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeInv}.pdf`;
  const blob = pdf.output('blob');
  const file = new File([blob], filename, { type: 'application/pdf' });
  return { blob, file, filename };
}

export function triggerPdfDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
