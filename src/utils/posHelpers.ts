import type { Product, Sale, StoreConfig } from '../types';

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
  const cashTotal = completed.filter((s) => s.paymentMethod === 'cash').reduce((a, s) => a + s.total, 0);
  const cardTotal = completed.filter((s) => s.paymentMethod === 'card').reduce((a, s) => a + s.total, 0);
  const qrTotal = completed.filter((s) => s.paymentMethod === 'bank_qr').reduce((a, s) => a + s.total, 0);

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
    ['Discounts Granted', totalDiscount.toFixed(2)],
    ['Cash Sales', cashTotal.toFixed(2)],
    ['Card Sales', cardTotal.toFixed(2)],
    ['Bank / QR Sales', qrTotal.toFixed(2)],
    [],
    ['INVOICE BREAKDOWN'],
    [
      'Invoice #',
      'Status',
      'Order Type',
      'Table / Customer',
      'Items',
      'Payment',
      'Subtotal',
      'Discount',
      'Tax',
      'Total',
      'Profit',
    ],
    ...daySales.map((s) => [
      s.invoiceNumber,
      s.status,
      s.orderType,
      s.tableNumber || s.customerName || '-',
      s.itemCount,
      s.paymentMethod,
      s.subtotal.toFixed(2),
      s.discount.toFixed(2),
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
      'Status',
      'Order Type',
      'Table / Customer',
      'Items Count',
      'Payment Method',
      'Subtotal',
      'Discount',
      'Tax',
      'Total',
      'Cost',
      'Profit',
    ],
    ...sales.map((s) => [
      s.dateKey,
      s.invoiceNumber,
      s.status,
      s.orderType,
      s.tableNumber || s.customerName || '-',
      s.itemCount,
      s.paymentMethod,
      s.subtotal.toFixed(2),
      s.discount.toFixed(2),
      s.taxAmount.toFixed(2),
      s.total.toFixed(2),
      s.totalCost.toFixed(2),
      s.profit.toFixed(2),
    ]),
  ];
  const slug = store.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  triggerCsvDownload(`${slug}-sales-ledger-${getTodayDateKey()}.csv`, rows);
}

export function exportInventoryCSV(store: StoreConfig, products: Product[]): void {
  const isRetail = store.businessType === 'retail';
  const headers = isRetail
    ? ['Name', 'SKU', 'Barcode', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Stock', 'Min Stock', 'Stock Cost Value', 'Retail Value']
    : ['Name', 'SKU', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Stock', 'Min Stock', 'Stock Cost Value', 'Menu Value'];

  const rows: (string | number)[][] = [
    headers,
    ...products.map((p) => {
      const base = isRetail
        ? [p.name, p.sku, p.barcode, p.category, p.unit]
        : [p.name, p.sku, p.category, p.unit];
      return [
        ...base,
        p.costPrice.toFixed(2),
        p.sellingPrice.toFixed(2),
        p.stock,
        p.minStock,
        (p.costPrice * p.stock).toFixed(2),
        (p.sellingPrice * p.stock).toFixed(2),
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
  { name: 'Chicken Karahi (Half)', sku: 'MN-001', barcode: '', category: 'Main Course', costPrice: 680, sellingPrice: 1350, stock: 30, minStock: 6, unit: 'dish' },
  { name: 'Mutton Biryani Special', sku: 'MN-002', barcode: '', category: 'Main Course', costPrice: 420, sellingPrice: 850, stock: 45, minStock: 10, unit: 'plate' },
  { name: 'Smoky Beef Smash Burger', sku: 'FF-001', barcode: '', category: 'Burgers & Grill', costPrice: 340, sellingPrice: 720, stock: 38, minStock: 8, unit: 'serving' },
  { name: 'Chicken Malai Boti', sku: 'BBQ-001', barcode: '', category: 'BBQ & Grill', costPrice: 390, sellingPrice: 780, stock: 25, minStock: 6, unit: 'skewer' },
  { name: 'Garlic Butter Naan', sku: 'BRD-001', barcode: '', category: 'Breads', costPrice: 35, sellingPrice: 110, stock: 120, minStock: 25, unit: 'pcs' },
  { name: 'Loaded Cheese Fries', sku: 'STR-001', barcode: '', category: 'Starters', costPrice: 180, sellingPrice: 420, stock: 40, minStock: 10, unit: 'bowl' },
  { name: 'Fresh Mint Margarita', sku: 'DRK-001', barcode: '', category: 'Drinks', costPrice: 80, sellingPrice: 260, stock: 60, minStock: 12, unit: 'glass' },
  { name: 'Karak Doodh Patti Chai', sku: 'DRK-002', barcode: '', category: 'Drinks', costPrice: 45, sellingPrice: 160, stock: 90, minStock: 15, unit: 'cup' },
];
