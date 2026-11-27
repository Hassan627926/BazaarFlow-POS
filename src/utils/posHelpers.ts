import type { PaymentSplit, Product, Sale, StoreConfig } from '../types';

export interface ThemePreset {
  id: string;
  name: string;
  primaryColor: string;
  accentColor: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'slate-teal', name: 'Teal Ledger', primaryColor: '#0F766E', accentColor: '#14B8A6' },
  { id: 'cobalt-pro', name: 'Cobalt Commerce', primaryColor: '#1D4ED8', accentColor: '#3B82F6' },
  { id: 'espresso-gold', name: 'Roastery Amber', primaryColor: '#B45309', accentColor: '#D97706' },
  { id: 'emerald-mart', name: 'Fresh Mart', primaryColor: '#15803D', accentColor: '#22C55E' },
  { id: 'crimson-bistro', name: 'Bistro Crimson', primaryColor: '#B91C1C', accentColor: '#EF4444' },
  { id: 'obsidian-ink', name: 'Graphite Mono', primaryColor: '#1E293B', accentColor: '#475569' },
];

export const CURRENCY_OPTIONS = ['PKR', 'Rs.', 'USD', '$', 'AED', 'SAR', 'GBP', 'EUR', 'INR'];

export function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 9);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`.replace(/[^a-zA-Z0-9_\-]/g, '');
}

export function getTodayDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatMoney(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const formatted = safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (['$', '£', '€', '₹'].includes(currency.trim())) {
    return `${currency.trim()}${formatted}`;
  }
  return `${currency.trim()} ${formatted}`;
}

export function formatDateTime(ts: Sale['createdAt'] | Date | null | undefined): string {
  if (!ts) return 'Just now';
  const date = ts instanceof Date ? ts : typeof ts.toDate === 'function' ? ts.toDate() : new Date();
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function generateInvoiceNumber(storeName: string): string {
  const prefix =
    storeName
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .slice(0, 3) || 'POS';
  const now = new Date();
  const ymd = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`;
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}-${ymd}-${seq}`;
}

export function formatDailyToken(tokenNumber?: number): string {
  if (!tokenNumber || !Number.isFinite(tokenNumber) || tokenNumber <= 0) return '';
  return `#${String(Math.floor(tokenNumber)).padStart(2, '0')}`;
}

export function getSaleTenderBreakdown(
  sale: Pick<Sale, 'paymentMethod' | 'paymentSplit' | 'total'>
): { cash: number; card: number; bank_qr: number } {
  if (sale.paymentMethod === 'split' && sale.paymentSplit) {
    const cash = Number(sale.paymentSplit.cash ?? 0);
    const card = Number(sale.paymentSplit.card ?? 0);
    const bank_qr = Number(sale.paymentSplit.bank_qr ?? 0);
    return {
      cash: Number.isFinite(cash) && cash > 0 ? Number(cash.toFixed(2)) : 0,
      card: Number.isFinite(card) && card > 0 ? Number(card.toFixed(2)) : 0,
      bank_qr: Number.isFinite(bank_qr) && bank_qr > 0 ? Number(bank_qr.toFixed(2)) : 0,
    };
  }
  const safeTotal = Number.isFinite(sale.total) && sale.total > 0 ? Number(sale.total.toFixed(2)) : 0;
  return {
    cash: sale.paymentMethod === 'cash' ? safeTotal : 0,
    card: sale.paymentMethod === 'card' ? safeTotal : 0,
    bank_qr: sale.paymentMethod === 'bank_qr' ? safeTotal : 0,
  };
}

export function formatSalePaymentLabel(
  sale: Pick<Sale, 'paymentMethod' | 'paymentSplit' | 'total'>,
  currency?: string
): string {
  if (sale.paymentMethod !== 'split') {
    return sale.paymentMethod === 'bank_qr' ? 'BANK/QR' : sale.paymentMethod.toUpperCase();
  }
  const split = getSaleTenderBreakdown(sale);
  const fmt = (val: number) => (currency ? formatMoney(val, currency) : val.toFixed(2));
  const parts: string[] = [];
  if (split.cash > 0) parts.push(`Cash ${fmt(split.cash)}`);
  if (split.card > 0) parts.push(`Card ${fmt(split.card)}`);
  if (split.bank_qr > 0) parts.push(`Bank/QR ${fmt(split.bank_qr)}`);
  return parts.length > 0 ? `SPLIT (${parts.join(' + ')})` : 'SPLIT';
}

export function computeSplitPaymentSettlement(params: {
  grandTotal: number;
  cashHandedInput: string;
  cardInput: string;
  bankQrInput: string;
}): {
  cashHanded: number;
  cardAmount: number;
  bankQrAmount: number;
  cashApplied: number;
  nonCashTotal: number;
  tenderedTotal: number;
  remainingToPay: number;
  changeDue: number;
  nonCashExceedsTotal: boolean;
  activeMethodsCount: number;
  paymentSplit: PaymentSplit;
} {
  const safeTotal = Math.max(0, Number(params.grandTotal.toFixed(2)));
  const parsePart = (raw: string) => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return 0;
    return Number(n.toFixed(2));
  };

  const cashHanded = parsePart(params.cashHandedInput);
  const cardAmount = parsePart(params.cardInput);
  const bankQrAmount = parsePart(params.bankQrInput);
  const nonCashTotal = Number((cardAmount + bankQrAmount).toFixed(2));
  const nonCashExceedsTotal = nonCashTotal > Number((safeTotal + 0.01).toFixed(2));

  const remainingAfterNonCash = Math.max(0, Number((safeTotal - nonCashTotal).toFixed(2)));
  const cashApplied = Number(Math.min(cashHanded, remainingAfterNonCash).toFixed(2));
  const changeDue =
    !nonCashExceedsTotal && cashHanded > remainingAfterNonCash
      ? Number((cashHanded - remainingAfterNonCash).toFixed(2))
      : 0;
  const tenderedTotal = Number((cashHanded + nonCashTotal).toFixed(2));
  const remainingToPay = Math.max(0, Number((safeTotal - tenderedTotal).toFixed(2)));

  const paymentSplit: PaymentSplit = {
    ...(cashApplied > 0 ? { cash: cashApplied } : {}),
    ...(cardAmount > 0 ? { card: cardAmount } : {}),
    ...(bankQrAmount > 0 ? { bank_qr: bankQrAmount } : {}),
  };

  const activeMethodsCount = [cashApplied > 0, cardAmount > 0, bankQrAmount > 0].filter(Boolean).length;

  return {
    cashHanded,
    cardAmount,
    bankQrAmount,
    cashApplied,
    nonCashTotal,
    tenderedTotal,
    remainingToPay,
    changeDue,
    nonCashExceedsTotal,
    activeMethodsCount,
    paymentSplit,
  };
}

/**
 * Generates a valid 13-digit EAN-13 barcode with checksum (strictly for Retail Shops).
 */
export function generateEAN13Barcode(): string {
  // Prefix 200-299 is reserved by GS1 for in-store / internal retail barcodes
  let digits = '20';
  for (let i = 0; i < 10; i++) {
    digits += Math.floor(Math.random() * 10).toString();
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = Number(digits[i]);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const checksum = (10 - (sum % 10)) % 10;
  return `${digits}${checksum}`;
}

/**
 * Compresses an uploaded brand logo to a clean PNG/WebP data URL under 80KB for Firestore.
 */
export function compressLogoImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file.'));
      img.onload = () => {
        const maxDim = 220;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable.'));
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        let dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > 90000) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        }
        if (dataUrl.length > 115000) {
          reject(new Error('Logo image is too large even after compression. Try a simpler logo.'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function escapeCsvCell(value: string | number): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function triggerCsvDownload(filename: string, rows: (string | number)[][]): void {
  const csvContent = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportDailySummaryCSV(store: StoreConfig, dateKey: string, sales: Sale[]): void {
  const daySales = sales.filter((s) => s.dateKey === dateKey);
  const completed = daySales.filter((s) => s.status === 'completed');
  const voided = daySales.filter((s) => s.status === 'voided');

  const totalRevenue = completed.reduce((acc, s) => acc + s.total, 0);
  const totalCost = completed.reduce((acc, s) => acc + s.totalCost, 0);
  const totalProfit = completed.reduce((acc, s) => acc + s.profit, 0);
  const totalTax = completed.reduce((acc, s) => acc + s.taxAmount, 0);
  const totalDiscount = completed.reduce((acc, s) => acc + s.discount, 0);
  const totalServiceCharge = completed.reduce((acc, s) => acc + (s.serviceChargeAmount ?? 0), 0);
  const totalDeliveryFee = completed.reduce((acc, s) => acc + (s.deliveryFee ?? 0), 0);
  const { cashTotal, cardTotal, qrTotal } = completed.reduce(
    (acc, s) => {
      const breakdown = getSaleTenderBreakdown(s);
      return {
        cashTotal: acc.cashTotal + breakdown.cash,
        cardTotal: acc.cardTotal + breakdown.card,
        qrTotal: acc.qrTotal + breakdown.bank_qr,
      };
    },
    { cashTotal: 0, cardTotal: 0, qrTotal: 0 }
  );

  const rows: (string | number)[][] = [
    ['DAILY OWNER SUMMARY REPORT'],
    ['Brand / Store', store.name],
    ['Business Type', store.businessType === 'retail' ? 'Retail / Shop' : 'Restaurant / Cafe'],
    ['Report Date', dateKey],
    ['Currency', store.currency],
    [],
    ['METRIC', 'VALUE'],
    ['Completed Orders', completed.length],
    ['Voided Orders', voided.length],
    ['Gross Revenue', totalRevenue.toFixed(2)],
    ['Total Cost of Goods (COGS)', totalCost.toFixed(2)],
    ['Net Profit', totalProfit.toFixed(2)],
    ['Tax Collected', totalTax.toFixed(2)],
    ['Service Charges Collected', totalServiceCharge.toFixed(2)],
    ['Delivery Fees Collected', totalDeliveryFee.toFixed(2)],
    ['Discounts Granted', totalDiscount.toFixed(2)],
    ['Cash Sales', cashTotal.toFixed(2)],
    ['Card Sales', cardTotal.toFixed(2)],
    ['Bank / QR Sales', qrTotal.toFixed(2)],
    [],
    ['INVOICE BREAKDOWN'],
    [
      'Invoice #',
      'Token #',
      'Status',
      'Order Type',
      'Table / Customer',
      'Handled By (Staff)',
      'Items',
      'Payment',
      'Subtotal',
      'Discount',
      'Service Charge',
      'Delivery Fee',
      'Tax',
      'Total',
      'Profit',
    ],
    ...daySales.map((s) => [
      s.invoiceNumber,
      formatDailyToken(s.tokenNumber) || '-',
      s.status,
      s.orderType,
      s.tableNumber || s.customerName || '-',
      s.employeeName || '-',
      s.itemCount,
      formatSalePaymentLabel(s),
      s.subtotal.toFixed(2),
      s.discount.toFixed(2),
      (s.serviceChargeAmount ?? 0).toFixed(2),
      (s.deliveryFee ?? 0).toFixed(2),
      s.taxAmount.toFixed(2),
      s.total.toFixed(2),
      s.profit.toFixed(2),
    ]),
  ];

  const slug = store.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  triggerCsvDownload(`${slug}-daily-summary-${dateKey}.csv`, rows);
}

export function exportSalesLedgerCSV(store: StoreConfig, sales: Sale[]): void {
  const rows: (string | number)[][] = [
    [
      'Date',
      'Invoice #',
      'Token #',
      'Status',
      'Order Type',
      'Table / Customer',
      'Handled By (Staff)',
      'Items Count',
      'Payment Method',
      'Subtotal',
      'Discount',
      'Service Charge',
      'Delivery Fee',
      'Tax',
      'Total',
      'Cost',
      'Profit',
    ],
    ...sales.map((s) => [
      s.dateKey,
      s.invoiceNumber,
      formatDailyToken(s.tokenNumber) || '-',
      s.status,
      s.orderType,
      s.tableNumber || s.customerName || '-',
      s.employeeName || '-',
      s.itemCount,
      formatSalePaymentLabel(s),
      s.subtotal.toFixed(2),
      s.discount.toFixed(2),
      (s.serviceChargeAmount ?? 0).toFixed(2),
      (s.deliveryFee ?? 0).toFixed(2),
      s.taxAmount.toFixed(2),
      s.total.toFixed(2),
      s.totalCost.toFixed(2),
      s.profit.toFixed(2),
    ]),
  ];
  const slug = store.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  triggerCsvDownload(`${slug}-sales-ledger-${getTodayDateKey()}.csv`, rows);
}

export const KITCHEN_QUICK_NOTES = [
  'Less Spicy',
  'Extra Spicy',
  'No Onion',
  'No Garlic',
  'No Ice',
  'Extra Cheese',
  'Well Done',
  'Separate Gravy',
] as const;

export function getLineItemKey(item: {
  productId: string;
  variantId?: string;
  variantName?: string;
  note?: string;
}): string {
  const variantKey = (item.variantId || item.variantName || '').trim().toLowerCase();
  const noteKey = (item.note || '').trim().toLowerCase();
  return `${item.productId}::${variantKey}::${noteKey}`;
}

export function formatDishNameWithVariant(baseName: string, variantName?: string): string {
  const cleanVariant = (variantName || '').trim();
  return cleanVariant ? `${baseName} (${cleanVariant})` : baseName;
}

export function isProductStockTracked(product: Pick<Product, 'trackStock'>): boolean {
  return product.trackStock !== false;
}

export function exportInventoryCSV(store: StoreConfig, products: Product[]): void {
  const isRetail = store.businessType === 'retail';
  const headers = isRetail
    ? ['Name', 'SKU', 'Barcode', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Stock', 'Min Stock', 'Stock Cost Value', 'Retail Value']
    : ['Name', 'SKU', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Stock', 'Min Stock', 'Stock Cost Value', 'Menu Value'];

  const rows: (string | number)[][] = [
    headers,
    ...products.map((p) => {
      const tracked = isProductStockTracked(p);
      const base = isRetail
        ? [p.name, p.sku, p.barcode, p.category, p.unit]
        : [p.name, p.sku, p.category, p.unit];
      return [
        ...base,
        p.costPrice.toFixed(2),
        p.sellingPrice.toFixed(2),
        tracked ? p.stock : 'Unlimited',
        tracked ? p.minStock : '—',
        tracked ? (p.costPrice * p.stock).toFixed(2) : '0.00',
        tracked ? (p.sellingPrice * p.stock).toFixed(2) : '0.00',
      ];
    }),
  ];

  const slug = store.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  triggerCsvDownload(`${slug}-inventory-${getTodayDateKey()}.csv`, rows);
}

export interface StarterProductTemplate {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  costPrice: number;
  sellingPrice: number;
  stock: number;
  minStock: number;
  unit: string;
  trackStock?: boolean;
}

export const RETAIL_STARTER_PRODUCTS: StarterProductTemplate[] = [
  { name: 'Basmati Rice 5kg', sku: 'GRC-001', barcode: '2010000100015', category: 'Groceries', costPrice: 1450, sellingPrice: 1750, stock: 42, minStock: 10, unit: 'bag' },
  { name: 'Cooking Oil 1L Pouch', sku: 'GRC-002', barcode: '2010000100022', category: 'Groceries', costPrice: 480, sellingPrice: 560, stock: 65, minStock: 15, unit: 'pack' },
  { name: 'Premium Black Tea 450g', sku: 'BEV-001', barcode: '2010000100039', category: 'Beverages', costPrice: 720, sellingPrice: 890, stock: 28, minStock: 8, unit: 'box' },
  { name: 'Mineral Water 1.5L', sku: 'BEV-002', barcode: '2010000100046', category: 'Beverages', costPrice: 65, sellingPrice: 100, stock: 96, minStock: 24, unit: 'bottle' },
  { name: 'Cotton Polo Shirt (L)', sku: 'APP-001', barcode: '2010000100053', category: 'Apparel', costPrice: 1100, sellingPrice: 1850, stock: 18, minStock: 6, unit: 'pcs' },
  { name: 'USB-C Fast Charger 30W', sku: 'ELC-001', barcode: '2010000100060', category: 'Electronics', costPrice: 950, sellingPrice: 1600, stock: 14, minStock: 5, unit: 'pcs' },
  { name: 'Herbal Shampoo 350ml', sku: 'PER-001', barcode: '2010000100077', category: 'Personal Care', costPrice: 410, sellingPrice: 590, stock: 7, minStock: 10, unit: 'bottle' },
  { name: 'Roasted Almonds 250g', sku: 'SNK-001', barcode: '2010000100084', category: 'Snacks', costPrice: 520, sellingPrice: 750, stock: 22, minStock: 8, unit: 'pack' },
];

export const RESTAURANT_STARTER_PRODUCTS: StarterProductTemplate[] = [
  { name: 'Chicken Karahi (Half)', sku: 'MN-001', barcode: '', category: 'Main Course', costPrice: 680, sellingPrice: 1350, stock: 0, minStock: 0, unit: 'dish', trackStock: false },
  { name: 'Mutton Biryani Special', sku: 'MN-002', barcode: '', category: 'Main Course', costPrice: 420, sellingPrice: 850, stock: 0, minStock: 0, unit: 'plate', trackStock: false },
  { name: 'Smoky Beef Smash Burger', sku: 'FF-001', barcode: '', category: 'Burgers & Grill', costPrice: 340, sellingPrice: 720, stock: 0, minStock: 0, unit: 'serving', trackStock: false },
  { name: 'Chicken Malai Boti', sku: 'BBQ-001', barcode: '', category: 'BBQ & Grill', costPrice: 390, sellingPrice: 780, stock: 0, minStock: 0, unit: 'skewer', trackStock: false },
  { name: 'Garlic Butter Naan', sku: 'BRD-001', barcode: '', category: 'Breads', costPrice: 35, sellingPrice: 110, stock: 0, minStock: 0, unit: 'pcs', trackStock: false },
  { name: 'Loaded Cheese Fries', sku: 'STR-001', barcode: '', category: 'Starters', costPrice: 180, sellingPrice: 420, stock: 0, minStock: 0, unit: 'bowl', trackStock: false },
  { name: 'Fresh Mint Margarita', sku: 'DRK-001', barcode: '', category: 'Drinks', costPrice: 80, sellingPrice: 260, stock: 0, minStock: 0, unit: 'glass', trackStock: false },
  { name: 'Karak Doodh Patti Chai', sku: 'DRK-002', barcode: '', category: 'Drinks', costPrice: 45, sellingPrice: 160, stock: 0, minStock: 0, unit: 'cup', trackStock: false },
];
