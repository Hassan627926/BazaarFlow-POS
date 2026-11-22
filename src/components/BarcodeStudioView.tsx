import React, { useMemo, useState } from 'react';
import { Printer, RefreshCw, Search } from 'lucide-react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { BarcodeLabelPrintItem, PrintJob, Product, StoreConfig } from '../types';
import { formatMoney, generateEAN13Barcode } from '../utils/posHelpers';
import { BarcodeSvg } from './BarcodeSvg';

interface BarcodeStudioViewProps {
  store: StoreConfig;
  products: Product[];
  onPrintJob: (job: PrintJob) => void;
}

export const BarcodeStudioView: React.FC<BarcodeStudioViewProps> = ({
  store,
  products,
  onPrintJob,
}) => {
  const [search, setSearch] = useState('');
  const [copiesMap, setCopiesMap] = useState<Record<string, number>>({});
  const [generatingMissing, setGeneratingMissing] = useState(false);

  const missingCount = useMemo(
    () => products.filter((p) => !p.barcode.trim()).length,
    [products]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
    );
  }, [products, search]);

  const selectedLabels = useMemo<BarcodeLabelPrintItem[]>(() => {
    return products
      .filter((p) => p.barcode.trim() && (copiesMap[p.id] ?? 0) > 0)
      .map((p) => ({ product: p, copies: copiesMap[p.id] }));
  }, [products, copiesMap]);

  const totalLabelsSelected = useMemo(
    () => selectedLabels.reduce((acc, item) => acc + item.copies, 0),
    [selectedLabels]
  );

  const handleGenerateMissingBarcodes = async () => {
    const targets = products.filter((p) => !p.barcode.trim());
    if (targets.length === 0) return;

    setGeneratingMissing(true);
    const path = `stores/${store.id}/products`;
    try {
      const batch = writeBatch(db);
      for (const p of targets) {
        batch.update(doc(db, 'stores', store.id, 'products', p.id), {
          barcode: generateEAN13Barcode(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setGeneratingMissing(false);
    }
  };

  const handleRegenerateSingle = async (product: Product) => {
    const path = `stores/${store.id}/products/${product.id}`;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'stores', store.id, 'products', product.id), {
        barcode: generateEAN13Barcode(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const setCopies = (productId: string, count: number) => {
    setCopiesMap((prev) => ({
      ...prev,
      [productId]: Math.max(0, Math.min(60, count)),
    }));
  };

  const handlePrintSelected = () => {
    if (selectedLabels.length === 0) return;
    onPrintJob({ type: 'barcodes', labels: selectedLabels });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search retail products to generate or print barcodes..."
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {missingCount > 0 && (
            <button
              type="button"
              disabled={generatingMissing}
              onClick={() => void handleGenerateMissingBarcodes()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>
                {generatingMissing
                  ? 'Generating...'
                  : `Auto-Generate ${missingCount} Missing`}
              </span>
            </button>
          )}

          <button
            type="button"
            disabled={totalLabelsSelected === 0}
            onClick={handlePrintSelected}
            className="inline-flex items-center gap-2 rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span>Print Selected Labels ({totalLabelsSelected})</span>
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          Add retail products in Inventory to generate scannable EAN-13 barcode labels.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((product) => {
            const qty = copiesMap[product.id] ?? 0;
            return (
              <div
                key={product.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {product.name}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {product.category} · {formatMoney(product.sellingPrice, store.currency)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRegenerateSingle(product)}
                    className="rounded-lg p-1.5 text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    title="Generate new EAN-13 barcode"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white p-3 flex items-center justify-center min-h-[78px]">
                  <BarcodeSvg value={product.barcode} height={42} width={1.45} fontSize={11} />
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-1.5">
                    <label
                      htmlFor={`copies-${product.id}`}
                      className="text-xs text-slate-500 dark:text-slate-400"
                    >
                      Labels:
                    </label>
                    <input
                      id={`copies-${product.id}`}
                      type="number"
                      min="0"
                      max="60"
                      value={qty}
                      onChange={(e) => setCopies(product.id, Number(e.target.value))}
                      className="w-16 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-center font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100"
                    />
                  </div>

                  <button
                    type="button"
                    disabled={!product.barcode.trim()}
                    onClick={() =>
                      onPrintJob({
                        type: 'barcodes',
                        labels: [{ product, copies: Math.max(1, qty || 4) }],
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap cursor-pointer"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Quick Print {qty > 0 ? `(${qty})` : '(4)'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
