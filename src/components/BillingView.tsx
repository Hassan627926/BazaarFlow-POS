import React, { useMemo, useRef, useState } from 'react';
import {
  Banknote,
  Barcode,
  CreditCard,
  Minus,
  Plus,
  Printer,
  QrCode,
  Search,
  ShoppingBag,
  Trash2,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type CartItem,
  type OrderType,
  type PaymentMethod,
  type PrintJob,
  type Product,
  type Sale,
  type StoreConfig,
} from '../types';
import {
  formatMoney,
  generateInvoiceNumber,
  generateSafeId,
  getTodayDateKey,
} from '../utils/posHelpers';

interface BillingViewProps {
  store: StoreConfig;
  products: Product[];
  ownerId: string;
  onPrintJob: (job: PrintJob) => void;
  onGoToInventory: () => void;
}

export const BillingView: React.FC<BillingViewProps> = ({
  store,
  products,
  ownerId,
  onPrintJob,
  onGoToInventory,
}) => {
  const isRetail = store.businessType === 'retail';
  const [searchQuery, setSearchQuery] = useState('');
  const [barcodeScanInput, setBarcodeScanInput] = useState('');
  const [scanMessage, setScanMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [discountInput, setDiscountInput] = useState<string>('0');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [amountTenderedInput, setAmountTenderedInput] = useState<string>('');
  const [orderType, setOrderType] = useState<OrderType>(isRetail ? 'retail' : 'dine_in');
  const [tableNumber, setTableNumber] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [processing, setProcessing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [lastCompletedSale, setLastCompletedSale] = useState<Sale | null>(null);

  const scanInputRef = useRef<HTMLInputElement | null>(null);

  const activeProducts = useMemo(() => products.filter((p) => p.active), [products]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    activeProducts.forEach((p) => set.add(p.category));
    return ['All', ...Array.from(set).sort()];
  }, [activeProducts]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeProducts.filter((p) => {
      if (selectedCategory !== 'All' && p.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (isRetail && p.barcode.toLowerCase().includes(q)) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [activeProducts, selectedCategory, searchQuery, isRetail]);

  const addToCart = (product: Product) => {
    if (product.stock <= 0) {
      setCheckoutError(`${product.name} is out of stock.`);
      return;
    }
    setCheckoutError(null);
    setCart((prev) => {
      const existing = prev.find((c) => c.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock) {
          setCheckoutError(`Only ${product.stock} ${product.unit} available for ${product.name}.`);
          return prev;
        }
        return prev.map((c) =>
          c.product.id === product.id ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  };

  const updateCartQty = (productId: string, delta: number) => {
    setCheckoutError(null);
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.product.id !== productId) return item;
          const nextQty = item.quantity + delta;
          if (nextQty > item.product.stock) {
            setCheckoutError(
              `Stock limit reached (${item.product.stock} ${item.product.unit}) for ${item.product.name}.`
            );
            return item;
          }
          return { ...item, quantity: nextQty };
        })
        .filter((item) => item.quantity > 0)
    );
  };

  const removeFromCart = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
  };

  const clearCart = () => {
    setCart([]);
    setDiscountInput('0');
    setAmountTenderedInput('');
    setTableNumber('');
    setCustomerName('');
    setCheckoutError(null);
  };

  const handleBarcodeScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isRetail) return;
    const code = barcodeScanInput.trim();
    if (!code) return;

    const match = activeProducts.find(
      (p) =>
        p.barcode.toLowerCase() === code.toLowerCase() ||
        p.sku.toLowerCase() === code.toLowerCase()
    );

    if (match) {
      addToCart(match);
      setScanMessage({ type: 'ok', text: `Added ${match.name}` });
    } else {
      setScanMessage({ type: 'err', text: `No product matches barcode "${code}"` });
    }
    setBarcodeScanInput('');
    scanInputRef.current?.focus();
    window.setTimeout(() => setScanMessage(null), 2600);
  };

  const subtotal = useMemo(
    () => cart.reduce((acc, c) => acc + c.product.sellingPrice * c.quantity, 0),
    [cart]
  );

  const totalCost = useMemo(
    () => cart.reduce((acc, c) => acc + c.product.costPrice * c.quantity, 0),
    [cart]
  );

  const discount = useMemo(() => {
    const val = Number(discountInput);
    if (!Number.isFinite(val) || val < 0) return 0;
    return Math.min(val, subtotal);
  }, [discountInput, subtotal]);

  const taxableBase = Math.max(0, subtotal - discount);
  const taxAmount = useMemo(
    () => Number(((taxableBase * store.taxRate) / 100).toFixed(2)),
    [taxableBase, store.taxRate]
  );
  const grandTotal = useMemo(() => Number((taxableBase + taxAmount).toFixed(2)), [taxableBase, taxAmount]);
  const totalItemsCount = useMemo(() => cart.reduce((acc, c) => acc + c.quantity, 0), [cart]);

  const parsedTendered = useMemo(() => {
    if (paymentMethod !== 'cash') return grandTotal;
    const val = Number(amountTenderedInput);
    if (!amountTenderedInput.trim() || !Number.isFinite(val)) return grandTotal;
    return val;
  }, [amountTenderedInput, grandTotal, paymentMethod]);

  const changeDue = Math.max(0, Number((parsedTendered - grandTotal).toFixed(2)));

  const handleCheckout = async (autoPrint: boolean) => {
    if (cart.length === 0) {
      setCheckoutError('Add at least one item to create a bill.');
      return;
    }
    if (cart.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setCheckoutError(`Maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct line items per bill.`);
      return;
    }
    if (paymentMethod === 'cash' && amountTenderedInput.trim() && parsedTendered < grandTotal) {
      setCheckoutError('Cash tendered is less than the grand total.');
      return;
    }

    setProcessing(true);
    setCheckoutError(null);

    const saleId = generateSafeId('sale');
    const invoiceNumber = generateInvoiceNumber(store.name);
    const dateKey = getTodayDateKey();
    const saleItems = cart.map((c) => ({
      productId: c.product.id,
      name: c.product.name,
      quantity: c.quantity,
      unitPrice: c.product.sellingPrice,
      costPrice: c.product.costPrice,
      lineTotal: Number((c.product.sellingPrice * c.quantity).toFixed(2)),
      sku: c.product.sku,
      barcode: isRetail ? c.product.barcode : '',
    }));

    const effectiveOrderType: OrderType = isRetail
      ? 'retail'
      : orderType === 'retail'
      ? 'dine_in'
      : orderType;

    const netProfit = Number((grandTotal - taxAmount - totalCost).toFixed(2));
    const salePath = `stores/${store.id}/sales/${saleId}`;

    try {
      const batch = writeBatch(db);
      const saleRef = doc(db, 'stores', store.id, 'sales', saleId);

      batch.set(saleRef, {
        ownerId,
        storeId: store.id,
        invoiceNumber,
        dateKey,
        items: saleItems,
        itemCount: totalItemsCount,
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        taxRate: store.taxRate,
        taxAmount,
        total: grandTotal,
        totalCost: Number(totalCost.toFixed(2)),
        profit: netProfit,
        paymentMethod,
        amountTendered: Number(parsedTendered.toFixed(2)),
        changeDue,
        orderType: effectiveOrderType,
        tableNumber: isRetail ? '' : tableNumber.trim().slice(0, BLUEPRINT_LIMITS.TABLE_MAX),
        customerName: customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX),
        status: 'completed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const c of cart) {
        const nextStock = Math.max(0, Number((c.product.stock - c.quantity).toFixed(2)));
        const prodRef = doc(db, 'stores', store.id, 'products', c.product.id);
        batch.update(prodRef, {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = generateSafeId('log');
        const logRef = doc(db, 'stores', store.id, 'stockLogs', logId);
        batch.set(logRef, {
          ownerId,
          storeId: store.id,
          productId: c.product.id,
          productName: c.product.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -c.quantity,
          previousStock: c.product.stock,
          newStock: nextStock,
          reason: 'sale',
          note: `Invoice ${invoiceNumber}`.slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      }

      await batch.commit();

      const completedSale: Sale = {
        id: saleId,
        ownerId,
        storeId: store.id,
        invoiceNumber,
        dateKey,
        items: saleItems,
        itemCount: totalItemsCount,
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        taxRate: store.taxRate,
        taxAmount,
        total: grandTotal,
        totalCost: Number(totalCost.toFixed(2)),
        profit: netProfit,
        paymentMethod,
        amountTendered: Number(parsedTendered.toFixed(2)),
        changeDue,
        orderType: effectiveOrderType,
        tableNumber: isRetail ? '' : tableNumber.trim(),
        customerName: customerName.trim(),
        status: 'completed',
        createdAt: null,
        updatedAt: null,
      };

      setLastCompletedSale(completedSale);
      clearCart();
      setMobileCartOpen(false);
      if (autoPrint) {
        onPrintJob({ type: 'receipt', sale: completedSale });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, salePath);
    } finally {
      setProcessing(false);
    }
  };

  const renderCartPanel = () => (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Current Bill
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cart.length > 0 && (
            <button
              type="button"
              onClick={clearCart}
              className="text-xs font-medium text-slate-500 hover:text-red-600 dark:hover:text-red-400 px-2 py-1 cursor-pointer"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setMobileCartOpen(false)}
            className="lg:hidden rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close cart"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Order metadata: Restaurant shows Order Type + Table, Retail shows optional Customer Name */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5 bg-slate-50/70 dark:bg-slate-950/40">
        {!isRetail && (
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
            {(
              [
                { id: 'dine_in', label: 'Dine-In' },
                { id: 'takeaway', label: 'Takeaway' },
                { id: 'delivery', label: 'Delivery' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setOrderType(opt.id)}
                className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  orderType === opt.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className={`grid gap-2 ${!isRetail ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {!isRetail && (
            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.TABLE_MAX}
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder="Table # (e.g. 04)"
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            />
          )}
          <input
            type="text"
            maxLength={BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX}
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder={isRetail ? 'Customer name (optional)' : 'Guest / Note (optional)'}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
          />
        </div>
      </div>

      {/* Cart Line Items */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 px-4">
        {cart.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <ShoppingBag className="w-7 h-7 mx-auto text-slate-300 dark:text-slate-600" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              No items in bill
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isRetail
                ? 'Tap a product or scan a barcode to start billing.'
                : 'Tap menu dishes on the left to build this order.'}
            </p>
          </div>
        ) : (
          cart.map(({ product, quantity }) => (
            <div key={product.id} className="py-3 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                  {product.name}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {formatMoney(product.sellingPrice, store.currency)} × {quantity}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => updateCartQty(product.id, -1)}
                  className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  aria-label={`Decrease ${product.name}`}
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="w-7 text-center text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {quantity}
                </span>
                <button
                  type="button"
                  onClick={() => updateCartQty(product.id, 1)}
                  className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  aria-label={`Increase ${product.name}`}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeFromCart(product.id)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                  aria-label={`Remove ${product.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Totals & Payment Controls */}
      <div className="border-t border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/70 dark:bg-slate-950/50">
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
            <span>Subtotal</span>
            <span className="font-mono tabular-nums">{formatMoney(subtotal, store.currency)}</span>
          </div>

          <div className="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
            <label htmlFor="pos-discount-input">Discount ({store.currency})</label>
            <input
              id="pos-discount-input"
              type="number"
              min="0"
              step="any"
              value={discountInput}
              onChange={(e) => setDiscountInput(e.target.value)}
              className="w-24 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
            />
          </div>

          {store.taxRate > 0 && (
            <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
              <span>Tax ({store.taxRate}%)</span>
              <span className="font-mono tabular-nums">{formatMoney(taxAmount, store.currency)}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-base font-bold text-slate-900 dark:text-slate-100">
            <span>Total</span>
            <span className="font-mono tabular-nums">{formatMoney(grandTotal, store.currency)}</span>
          </div>
        </div>

        {/* Payment Method Selector */}
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { id: 'cash', label: 'Cash', icon: Banknote },
              { id: 'card', label: 'Card', icon: CreditCard },
              { id: 'bank_qr', label: 'Bank/QR', icon: QrCode },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setPaymentMethod(id)}
              className={`flex items-center justify-center gap-1.5 rounded-lg border py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                paymentMethod === id
                  ? 'brand-border brand-soft-bg brand-text'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {paymentMethod === 'cash' && grandTotal > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="cash-tendered-input" className="text-slate-600 dark:text-slate-400">
                Cash Received
              </label>
              <input
                id="cash-tendered-input"
                type="number"
                min="0"
                step="any"
                value={amountTenderedInput}
                onChange={(e) => setAmountTenderedInput(e.target.value)}
                placeholder={grandTotal.toFixed(2)}
                className="w-28 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            {changeDue > 0 && (
              <div className="flex items-center justify-between text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <span>Change Due</span>
                <span className="font-mono tabular-nums">{formatMoney(changeDue, store.currency)}</span>
              </div>
            )}
          </div>
        )}

        {checkoutError && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {checkoutError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            disabled={processing || cart.length === 0}
            onClick={() => void handleCheckout(true)}
            className="w-full flex items-center justify-center gap-2 rounded-lg brand-bg px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 transition-opacity cursor-pointer"
          >
            <Printer className="w-4 h-4 shrink-0" />
            <span>{processing ? 'Completing...' : 'Complete & Print Bill'}</span>
          </button>

          <button
            type="button"
            disabled={processing || cart.length === 0}
            onClick={() => void handleCheckout(false)}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
          >
            Save Sale Without Printing
          </button>
        </div>

        {lastCompletedSale && (
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-400 truncate">
              Last: <strong className="font-mono">{lastCompletedSale.invoiceNumber}</strong>
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onPrintJob({ type: 'receipt', sale: lastCompletedSale })}
                className="font-medium brand-text hover:underline cursor-pointer"
              >
                Reprint Bill
              </button>
              {!isRetail && (
                <button
                  type="button"
                  onClick={() => onPrintJob({ type: 'kot', sale: lastCompletedSale })}
                  className="font-medium text-amber-700 dark:text-amber-400 hover:underline cursor-pointer"
                >
                  Print KOT
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start pb-20 lg:pb-0">
      {/* Left: Catalog & Controls */}
      <div className="lg:col-span-8 space-y-4">
        {/* Search & Retail Barcode Scan Bar */}
        <div className={`grid gap-3 ${isRetail ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                isRetail ? 'Search products, SKU, or category...' : 'Search menu dishes or category...'
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-300"
            />
          </div>

          {isRetail && (
            <form onSubmit={handleBarcodeScanSubmit} className="relative flex gap-2">
              <div className="relative flex-1">
                <Barcode className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={scanInputRef}
                  type="text"
                  value={barcodeScanInput}
                  onChange={(e) => setBarcodeScanInput(e.target.value)}
                  placeholder="Scan barcode & press Enter..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-10 pr-3 py-2.5 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-300"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Scan Add
              </button>
            </form>
          )}
        </div>

        {scanMessage && (
          <div
            className={`text-xs font-medium px-3.5 py-2 rounded-lg border ${
              scanMessage.type === 'ok'
                ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300'
                : 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'
            }`}
          >
            {scanMessage.text}
          </div>
        )}

        {/* Category Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                selectedCategory === cat
                  ? 'brand-bg text-white'
                  : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Product Grid */}
        {activeProducts.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              No {isRetail ? 'products' : 'menu items'} in your catalog yet
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Add items in Inventory to start generating bills, tracking stock, and exporting daily reports.
            </p>
            <button
              type="button"
              onClick={onGoToInventory}
              className="rounded-lg brand-bg px-4 py-2.5 text-sm font-medium text-white cursor-pointer"
            >
              Add First Item
            </button>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No items match your current filter.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredProducts.map((product) => {
              const inCart = cart.find((c) => c.product.id === product.id)?.quantity ?? 0;
              const isOut = product.stock <= 0;
              const isLow = product.stock > 0 && product.stock <= product.minStock;

              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={isOut}
                  onClick={() => addToCart(product)}
                  className={`group text-left rounded-xl border p-3.5 transition-all flex flex-col justify-between min-h-[116px] cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed ${
                    inCart > 0
                      ? 'brand-border brand-soft-bg'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-600'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug line-clamp-2">
                        {product.name}
                      </span>
                      {inCart > 0 && (
                        <span className="text-xs font-mono font-bold brand-text shrink-0">
                          ×{inCart}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                      {product.category}
                      {isRetail && product.sku ? ` · ${product.sku}` : ''}
                    </div>
                  </div>

                  <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {formatMoney(product.sellingPrice, store.currency)}
                    </span>
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        isOut
                          ? 'text-red-600 dark:text-red-400 font-semibold'
                          : isLow
                          ? 'text-amber-600 dark:text-amber-400 font-medium'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {isOut ? 'Out' : `${product.stock} ${product.unit}`}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Desktop Sticky Cart Panel */}
      <div className="hidden lg:block lg:col-span-4 lg:sticky lg:top-20 lg:h-[calc(100vh-6.5rem)]">
        {renderCartPanel()}
      </div>

      {/* Mobile Bottom Checkout Bar (under 15% mobile sticky cap) */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 no-print">
        <button
          type="button"
          onClick={() => setMobileCartOpen(true)}
          className="w-full flex items-center justify-between rounded-lg brand-bg px-4 py-3 text-sm font-semibold text-white cursor-pointer"
        >
          <span>
            View Bill ({totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'})
          </span>
          <span className="font-mono tabular-nums">{formatMoney(grandTotal, store.currency)}</span>
        </button>
      </div>

      {/* Mobile Slide-Over Cart Modal */}
      {mobileCartOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-slate-950/65 flex justify-end p-2">
          <div className="w-full max-w-md h-full">{renderCartPanel()}</div>
        </div>
      )}
    </div>
  );
};
