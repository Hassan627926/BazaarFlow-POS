import React, { useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Barcode,
  Download,
  Edit3,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { deleteDoc, doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type Product,
  type StockLog,
  type StockReason,
  type StoreConfig,
} from '../types';
import {
  exportInventoryCSV,
  formatDateTime,
  formatMoney,
  generateEAN13Barcode,
  generateSafeId,
} from '../utils/posHelpers';
import { BarcodeSvg } from './BarcodeSvg';

interface InventoryViewProps {
  store: StoreConfig;
  products: Product[];
  stockLogs: StockLog[];
  ownerId: string;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  store,
  products,
  stockLogs,
  ownerId,
}) => {
  const isRetail = store.businessType === 'retail';
  const [subTab, setSubTab] = useState<'items' | 'logs'>('items');
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');

  // Product Form Modal State
  const [formOpen, setFormOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [category, setCategory] = useState(isRetail ? 'Groceries' : 'Main Course');
  const [costPrice, setCostPrice] = useState('0');
  const [sellingPrice, setSellingPrice] = useState('0');
  const [stock, setStock] = useState('0');
  const [minStock, setMinStock] = useState('5');
  const [unit, setUnit] = useState(isRetail ? 'pcs' : 'plate');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Quick Stock Adjustment Modal State
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null);
  const [adjustReason, setAdjustReason] = useState<StockReason>('restock');
  const [adjustQty, setAdjustQty] = useState('10');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjustSaving, setAdjustSaving] = useState(false);

  const metrics = useMemo(() => {
    const totalSkus = products.length;
    const totalUnits = products.reduce((a, p) => a + p.stock, 0);
    const costValue = products.reduce((a, p) => a + p.costPrice * p.stock, 0);
    const retailValue = products.reduce((a, p) => a + p.sellingPrice * p.stock, 0);
    const lowStock = products.filter((p) => p.stock > 0 && p.stock <= p.minStock).length;
    const outStock = products.filter((p) => p.stock <= 0).length;
    return { totalSkus, totalUnits, costValue, retailValue, lowStock, outStock };
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (stockFilter === 'low' && !(p.stock > 0 && p.stock <= p.minStock)) return false;
      if (stockFilter === 'out' && p.stock > 0) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (isRetail && p.barcode.toLowerCase().includes(q))
      );
    });
  }, [products, search, stockFilter, isRetail]);

  const openCreateModal = () => {
    setEditingProduct(null);
    setName('');
    setSku('');
    setBarcode(isRetail ? generateEAN13Barcode() : '');
    setCategory(isRetail ? 'General' : 'Main Course');
    setCostPrice('');
    setSellingPrice('');
    setStock('20');
    setMinStock('5');
    setUnit(isRetail ? 'pcs' : 'plate');
    setActive(true);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditModal = (product: Product) => {
    setEditingProduct(product);
    setName(product.name);
    setSku(product.sku);
    setBarcode(isRetail ? product.barcode : '');
    setCategory(product.category);
    setCostPrice(String(product.costPrice));
    setSellingPrice(String(product.sellingPrice));
    setStock(String(product.stock));
    setMinStock(String(product.minStock));
    setUnit(product.unit);
    setActive(product.active);
    setFormError(null);
    setFormOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanCat = category.trim();
    const parsedCost = Number(costPrice || 0);
    const parsedSell = Number(sellingPrice || 0);
    const parsedStock = Number(stock || 0);
    const parsedMin = Number(minStock || 0);

    if (!cleanName || !cleanCat) {
      setFormError('Item name and category are required.');
      return;
    }
    if (
      [parsedCost, parsedSell, parsedStock, parsedMin].some((v) => !Number.isFinite(v) || v < 0)
    ) {
      setFormError('Prices and stock levels must be valid non-negative numbers.');
      return;
    }

    setSaving(true);
    setFormError(null);

    const productId = editingProduct ? editingProduct.id : generateSafeId('prod');
    const path = `stores/${store.id}/products/${productId}`;
    const safeBarcode = isRetail ? barcode.trim().slice(0, BLUEPRINT_LIMITS.BARCODE_MAX) : '';

    try {
      const ref = doc(db, 'stores', store.id, 'products', productId);
      if (editingProduct) {
        const batch = writeBatch(db);
        batch.update(ref, {
          name: cleanName.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          sku: sku.trim().slice(0, BLUEPRINT_LIMITS.SKU_MAX),
          barcode: safeBarcode,
          category: cleanCat.slice(0, BLUEPRINT_LIMITS.CATEGORY_MAX),
          costPrice: parsedCost,
          sellingPrice: parsedSell,
          stock: parsedStock,
          minStock: parsedMin,
          unit: unit.trim().slice(0, BLUEPRINT_LIMITS.UNIT_MAX) || 'pcs',
          active,
          updatedAt: serverTimestamp(),
        });

        if (parsedStock !== editingProduct.stock) {
          const logId = generateSafeId('log');
          batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
            ownerId,
            storeId: store.id,
            productId,
            productName: cleanName.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
            change: Number((parsedStock - editingProduct.stock).toFixed(2)),
            previousStock: editingProduct.stock,
            newStock: parsedStock,
            reason: 'adjustment',
            note: 'Updated from product editor',
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      } else {
        await setDoc(ref, {
          ownerId,
          storeId: store.id,
          name: cleanName.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          sku: sku.trim().slice(0, BLUEPRINT_LIMITS.SKU_MAX),
          barcode: safeBarcode,
          category: cleanCat.slice(0, BLUEPRINT_LIMITS.CATEGORY_MAX),
          costPrice: parsedCost,
          sellingPrice: parsedSell,
          stock: parsedStock,
          minStock: parsedMin,
          unit: unit.trim().slice(0, BLUEPRINT_LIMITS.UNIT_MAX) || 'pcs',
          active,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setFormOpen(false);
    } catch (err) {
      handleFirestoreError(err, editingProduct ? OperationType.UPDATE : OperationType.CREATE, path);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProduct = async (product: Product) => {
    const path = `stores/${store.id}/products/${product.id}`;
    try {
      await deleteDoc(doc(db, 'stores', store.id, 'products', product.id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const handleAdjustStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustingProduct) return;
    const qty = Number(adjustQty);
    if (!Number.isFinite(qty) || qty <= 0) return;

    let newStock = adjustingProduct.stock;
    let delta = 0;

    if (adjustReason === 'restock') {
      delta = qty;
      newStock = Number((adjustingProduct.stock + qty).toFixed(2));
    } else if (adjustReason === 'damage') {
      delta = -Math.min(qty, adjustingProduct.stock);
      newStock = Math.max(0, Number((adjustingProduct.stock - qty).toFixed(2)));
    } else {
      newStock = Math.max(0, qty);
      delta = Number((newStock - adjustingProduct.stock).toFixed(2));
    }

    setAdjustSaving(true);
    const path = `stores/${store.id}/products/${adjustingProduct.id}`;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'stores', store.id, 'products', adjustingProduct.id), {
        stock: newStock,
        updatedAt: serverTimestamp(),
      });
      const logId = generateSafeId('log');
      batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
        ownerId,
        storeId: store.id,
        productId: adjustingProduct.id,
        productName: adjustingProduct.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
        change: delta,
        previousStock: adjustingProduct.stock,
        newStock,
        reason: adjustReason,
        note: (adjustNote.trim() || adjustReason).slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setAdjustingProduct(null);
      setAdjustNote('');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setAdjustSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* KPI Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Total {isRetail ? 'Products' : 'Menu Dishes'}
          </div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {metrics.totalSkus}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {metrics.totalUnits} total units
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Stock Cost Value</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(metrics.costValue, store.currency)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">At purchase cost</div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Potential Retail Value</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(metrics.retailValue, store.currency)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">At selling price</div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Attention Needed</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-600 dark:text-amber-400">
            {metrics.lowStock + metrics.outStock}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {metrics.lowStock} low · {metrics.outStock} out of stock
          </div>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => setSubTab('items')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              subTab === 'items'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Catalog & Stock ({products.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('logs')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              subTab === 'logs'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Stock Movement Log ({stockLogs.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportInventoryCSV(store, products)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Inventory CSV</span>
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add {isRetail ? 'Product' : 'Menu Item'}</span>
          </button>
        </div>
      </div>

      {subTab === 'items' ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-200 dark:border-slate-800">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={isRetail ? 'Filter by name, SKU, or barcode...' : 'Filter by dish or category...'}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'low', label: 'Low Stock' },
                  { id: 'out', label: 'Out of Stock' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStockFilter(f.id)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    stockFilter === f.id
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/80 dark:bg-slate-950/40">
                  <th className="py-3 px-4">Item</th>
                  <th className="py-3 px-4">Category</th>
                  {isRetail && <th className="py-3 px-4">Barcode</th>}
                  <th className="py-3 px-4 text-right">Cost</th>
                  <th className="py-3 px-4 text-right">Price</th>
                  <th className="py-3 px-4 text-right">Stock</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={isRetail ? 7 : 6}
                      className="py-10 text-center text-sm text-slate-500 dark:text-slate-400"
                    >
                      No inventory items found.
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((p) => {
                    const isOut = p.stock <= 0;
                    const isLow = p.stock > 0 && p.stock <= p.minStock;
                    return (
                      <tr
                        key={p.id}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {p.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {p.sku || 'No SKU'} · {p.active ? 'Active' : 'Hidden'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-300">
                          {p.category}
                        </td>
                        {isRetail && (
                          <td className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-300">
                            {p.barcode || '—'}
                          </td>
                        )}
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-400">
                          {formatMoney(p.costPrice, store.currency)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {formatMoney(p.sellingPrice, store.currency)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">
                          <span
                            className={
                              isOut
                                ? 'text-red-600 dark:text-red-400 font-semibold'
                                : isLow
                                ? 'text-amber-600 dark:text-amber-400 font-semibold'
                                : 'text-slate-900 dark:text-slate-100'
                            }
                          >
                            {p.stock} {p.unit}
                          </span>
                          <div className="text-[11px] text-slate-400">
                            {isOut ? 'Out of stock' : isLow ? 'Low stock' : `Min ${p.minStock}`}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setAdjustingProduct(p);
                                setAdjustReason('restock');
                                setAdjustQty('10');
                                setAdjustNote('');
                              }}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
                              title="Adjust Stock"
                            >
                              <ArrowUpDown className="w-3.5 h-3.5 inline mr-1" />
                              Stock
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditModal(p)}
                              className="rounded-lg p-2 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                              aria-label={`Edit ${p.name}`}
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteProduct(p)}
                              className="rounded-lg p-2 text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                              aria-label={`Delete ${p.name}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/80 dark:bg-slate-950/40">
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Item</th>
                  <th className="py-3 px-4">Reason</th>
                  <th className="py-3 px-4 text-right">Change</th>
                  <th className="py-3 px-4 text-right">New Stock</th>
                  <th className="py-3 px-4">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {stockLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-500 dark:text-slate-400">
                      No stock movement records yet.
                    </td>
                  </tr>
                ) : (
                  stockLogs.slice(0, 80).map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-4 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-slate-100">
                        {log.productName}
                      </td>
                      <td className="py-2.5 px-4 capitalize text-slate-600 dark:text-slate-300">
                        {log.reason.replace('_', ' ')}
                      </td>
                      <td
                        className={`py-2.5 px-4 text-right font-mono font-semibold tabular-nums ${
                          log.change >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {log.change > 0 ? `+${log.change}` : log.change}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {log.newStock}
                      </td>
                      <td className="py-2.5 px-4 text-slate-500 dark:text-slate-400">{log.note}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add / Edit Product Modal */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl my-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold font-display text-slate-900 dark:text-slate-100">
                {editingProduct
                  ? `Edit ${isRetail ? 'Product' : 'Menu Item'}`
                  : `Add ${isRetail ? 'Product' : 'Menu Item'}`}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="mt-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isRetail ? 'Product Name' : 'Dish / Item Name'}
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={BLUEPRINT_LIMITS.PRODUCT_NAME_MAX}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Category
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={BLUEPRINT_LIMITS.CATEGORY_MAX}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    SKU / Code
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.SKU_MAX}
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="e.g. ITEM-104"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>

                {/* Barcode Generator: STRICTLY Retail Shops Only — Hidden for Restaurants */}
                {isRetail && (
                  <div className="sm:col-span-2 space-y-2">
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Product Barcode (EAN-13 / Code128)
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Barcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          maxLength={BLUEPRINT_LIMITS.BARCODE_MAX}
                          value={barcode}
                          onChange={(e) => setBarcode(e.target.value)}
                          placeholder="Scan or generate barcode"
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-9 pr-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setBarcode(generateEAN13Barcode())}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Generate</span>
                      </button>
                    </div>
                    {barcode.trim() && (
                      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-2.5 flex justify-center">
                        <BarcodeSvg value={barcode} height={38} width={1.45} fontSize={11} />
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Cost Price ({store.currency})
                  </label>
                  <input
                    type="number"
                    required
                    min="0"
                    step="any"
                    value={costPrice}
                    onChange={(e) => setCostPrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Selling Price ({store.currency})
                  </label>
                  <input
                    type="number"
                    required
                    min="0"
                    step="any"
                    value={sellingPrice}
                    onChange={(e) => setSellingPrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Opening / Current Stock
                  </label>
                  <input
                    type="number"
                    required
                    min="0"
                    step="any"
                    value={stock}
                    onChange={(e) => setStock(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Low Alert
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      step="any"
                      value={minStock}
                      onChange={(e) => setMinStock(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Unit
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.UNIT_MAX}
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                      placeholder="pcs"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>Available for sale on POS Billing terminal</span>
              </label>

              {formError && (
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg brand-bg px-5 py-2 text-xs font-semibold text-white disabled:opacity-60 cursor-pointer"
                >
                  {saving ? 'Saving...' : editingProduct ? 'Save Changes' : 'Add Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {adjustingProduct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                  Adjust Stock · {adjustingProduct.name}
                </h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono">
                  Current stock: {adjustingProduct.stock} {adjustingProduct.unit}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdjustingProduct(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAdjustStock} className="mt-4 space-y-4">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'restock', label: 'Restock (+)' },
                    { id: 'damage', label: 'Damage (-)' },
                    { id: 'adjustment', label: 'Set Exact' },
                  ] as const
                ).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setAdjustReason(r.id)}
                    className={`rounded-lg border py-2 px-2 text-xs font-medium cursor-pointer ${
                      adjustReason === r.id
                        ? 'brand-border brand-soft-bg brand-text'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {adjustReason === 'adjustment' ? 'New Exact Stock Quantity' : 'Quantity'}
                </label>
                <input
                  type="number"
                  required
                  min="0.01"
                  step="any"
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Audit Note (optional)
                </label>
                <input
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.STOCK_NOTE_MAX}
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                  placeholder="Supplier delivery #42, damaged pack, etc."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setAdjustingProduct(null)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adjustSaving}
                  className="rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60 cursor-pointer"
                >
                  {adjustSaving ? 'Updating...' : 'Apply Stock Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
