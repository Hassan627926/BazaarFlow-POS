import type { Timestamp } from 'firebase/firestore';

export type BusinessType = 'retail' | 'restaurant';
export type PaymentMethod = 'cash' | 'card' | 'bank_qr';
export type OrderType = 'retail' | 'dine_in' | 'takeaway' | 'delivery';
export type SaleStatus = 'completed' | 'voided';
export type StockReason = 'restock' | 'sale' | 'void_restore' | 'damage' | 'adjustment';

export type AppTab =
  | 'billing'
  | 'waiter'
  | 'kot_queue'
  | 'inventory'
  | 'barcodes'
  | 'sales'
  | 'employees'
  | 'analytics'
  | 'settings';

export const BLUEPRINT_LIMITS = {
  STORE_NAME_MAX: 80,
  LOGO_DATA_URL_MAX: 120000,
  CURRENCY_MAX: 10,
  TAX_RATE_MAX: 50,
  TABLE_COUNT_DEFAULT: 12,
  TABLE_COUNT_MAX: 60,
  ADDRESS_MAX: 200,
  CUSTOMER_ADDRESS_MAX: 220,
  PHONE_MAX: 32,
  RECEIPT_FOOTER_MAX: 180,
  PRODUCT_NAME_MAX: 100,
  SKU_MAX: 40,
  BARCODE_MAX: 48,
  CATEGORY_MAX: 50,
  UNIT_MAX: 20,
  INVOICE_MAX: 40,
  TABLE_MAX: 20,
  CUSTOMER_NAME_MAX: 80,
  EMPLOYEE_NAME_MAX: 80,
  EMPLOYEE_ROLE_MAX: 40,
  EMPLOYEE_CNIC_MAX: 32,
  EMPLOYEE_SHIFT_MAX: 40,
  EMPLOYEE_NOTES_MAX: 160,
  EMPLOYEE_EMAIL_MAX: 120,
  STOCK_NOTE_MAX: 160,
  SALE_ITEMS_MAX: 100,
  HEX_COLOR_REGEX: /^#[0-9a-fA-F]{6}$/,
  ID_REGEX: /^[a-zA-Z0-9_\-]+$/,
} as const;

export interface StoreConfig {
  id: string;
  ownerId: string;
  name: string;
  businessType: BusinessType;
  logoDataUrl: string;
  primaryColor: string;
  accentColor: string;
  currency: string;
  taxRate: number;
  tableCount?: number;
  address: string;
  phone: string;
  receiptFooter: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface Product {
  id: string;
  ownerId: string;
  storeId: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  costPrice: number;
  sellingPrice: number;
  stock: number;
  minStock: number;
  unit: string;
  active: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface SaleItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  lineTotal: number;
  sku: string;
  barcode: string;
}

export interface Sale {
  id: string;
  ownerId: string;
  storeId: string;
  invoiceNumber: string;
  dateKey: string;
  items: SaleItem[];
  itemCount: number;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  totalCost: number;
  profit: number;
  paymentMethod: PaymentMethod;
  amountTendered: number;
  changeDue: number;
  orderType: OrderType;
  tableNumber: string;
  customerName: string;
  customerPhone?: string;
  customerAddress?: string;
  employeeId?: string;
  employeeName?: string;
  settledBy?: 'counter' | 'waiter_mobile';
  status: SaleStatus;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface StockLog {
  id: string;
  ownerId: string;
  storeId: string;
  productId: string;
  productName: string;
  change: number;
  previousStock: number;
  newStock: number;
  reason: StockReason;
  note: string;
  createdAt?: Timestamp | null;
}

export interface TableSession {
  id: string;
  ownerId: string;
  storeId: string;
  tableNumber: string;
  status: 'occupied';
  items: SaleItem[];
  itemCount: number;
  subtotal: number;
  totalCost: number;
  customerName: string;
  employeeId?: string;
  employeeName?: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface Customer {
  id: string;
  ownerId: string;
  storeId: string;
  name: string;
  phone: string;
  phoneDigits: string;
  address: string;
  orderCount: number;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface Employee {
  id: string;
  ownerId: string;
  storeId: string;
  name: string;
  role: string;
  phone: string;
  cnic: string;
  shift: string;
  notes: string;
  loginEmail?: string;
  waiterUid?: string;
  mobileAccess?: boolean;
  canEditOrders?: boolean;
  canPrintKot?: boolean;
  canViewPrices?: boolean;
  canSettleBills?: boolean;
  active: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface WaiterAccess {
  id: string;
  ownerId: string;
  storeId: string;
  storeName: string;
  employeeId: string;
  employeeName: string;
  role: string;
  waiterEmail: string;
  waiterUid?: string;
  canEditOrders?: boolean;
  canPrintKot?: boolean;
  canViewPrices?: boolean;
  canSettleBills?: boolean;
  active: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export type KotTicketKind = 'new' | 'addon' | 'revised' | 'reprint';
export type KotTicketStatus = 'pending' | 'printed';

export interface KotTicket {
  id: string;
  ownerId: string;
  storeId: string;
  ticketNumber: string;
  tableNumber: string;
  orderType: OrderType;
  ticketKind: KotTicketKind;
  items: SaleItem[];
  itemCount: number;
  changeNotes?: string[];
  customerName: string;
  employeeId?: string;
  employeeName?: string;
  source: 'waiter_mobile' | 'counter';
  status: KotTicketStatus;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface BarcodeLabelPrintItem {
  product: Product;
  copies: number;
}

export type PrintJob =
  | { type: 'receipt'; sale: Sale }
  | {
      type: 'kot';
      sale: Sale;
      isAddOn?: boolean;
      isRevised?: boolean;
      changeNotes?: string[];
      kotId?: string;
      autoPrint?: boolean;
    }
  | { type: 'barcodes'; labels: BarcodeLabelPrintItem[] }
  | { type: 'daily_report'; dateKey: string; sales: Sale[]; products: Product[] };
