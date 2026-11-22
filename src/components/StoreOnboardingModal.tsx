import React, { useState } from 'react';
import { Store, UtensilsCrossed, X } from 'lucide-react';
import { BLUEPRINT_LIMITS, type BusinessType } from '../types';
import { CURRENCY_OPTIONS, THEME_PRESETS } from '../utils/posHelpers';

export interface NewStorePayload {
  name: string;
  businessType: BusinessType;
  currency: string;
  taxRate: number;
  primaryColor: string;
  accentColor: string;
  address: string;
  phone: string;
  seedStarterCatalog: boolean;
}

interface StoreOnboardingModalProps {
  isOpen: boolean;
  canClose: boolean;
  onClose: () => void;
  onCreate: (payload: NewStorePayload) => Promise<void>;
}

export const StoreOnboardingModal: React.FC<StoreOnboardingModalProps> = ({
  isOpen,
  canClose,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [businessType, setBusinessType] = useState<BusinessType>('retail');
  const [currency, setCurrency] = useState('PKR');
  const [taxRate, setTaxRate] = useState('0');
  const [primaryColor, setPrimaryColor] = useState(THEME_PRESETS[0].primaryColor);
  const [accentColor, setAccentColor] = useState(THEME_PRESETS[0].accentColor);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [seedStarterCatalog, setSeedStarterCatalog] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter your brand or shop name.');
      return;
    }
    const parsedTax = Number(taxRate);
    if (Number.isNaN(parsedTax) || parsedTax < 0 || parsedTax > 50) {
      setError('Tax rate must be between 0% and 50%.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: trimmedName.slice(0, BLUEPRINT_LIMITS.STORE_NAME_MAX),
        businessType,
        currency: currency.trim().slice(0, BLUEPRINT_LIMITS.CURRENCY_MAX) || 'PKR',
        taxRate: parsedTax,
        primaryColor,
        accentColor,
        address: address.trim().slice(0, BLUEPRINT_LIMITS.ADDRESS_MAX),
        phone: phone.trim().slice(0, BLUEPRINT_LIMITS.PHONE_MAX),
        seedStarterCatalog,
      });
      setName('');
      setAddress('');
      setPhone('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create store.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl my-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold font-display text-slate-900 dark:text-slate-100">
              Create Brand Workspace
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Each shop or restaurant gets its own branding, theme colors, inventory, and billing mode.
            </p>
          </div>
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-5">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              Business Type
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setBusinessType('retail')}
                className={`flex flex-col items-start text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                  businessType === 'retail'
                    ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <Store className="w-4 h-4" />
                  <span>Retail / Shop</span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Includes EAN-13 Barcode generator, label printing & scanner checkout.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setBusinessType('restaurant')}
                className={`flex flex-col items-start text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                  businessType === 'restaurant'
                    ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <UtensilsCrossed className="w-4 h-4" />
                  <span>Restaurant / Cafe</span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Table numbers, Dine-In / Takeaway / Delivery & KOT printing (no barcodes).
                </p>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="store-name-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Brand / Shop Name
              </label>
              <input
                id="store-name-input"
                type="text"
                required
                maxLength={BLUEPRINT_LIMITS.STORE_NAME_MAX}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  businessType === 'retail'
                    ? 'e.g., Al-Madina Super Mart'
                    : 'e.g., Spice Courtyard Kitchen'
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-300"
              />
            </div>

            <div>
              <label
                htmlFor="store-currency-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Currency
              </label>
              <select
                id="store-currency-select"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100"
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="store-tax-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Default Tax Rate (%)
              </label>
              <input
                id="store-tax-input"
                type="number"
                min="0"
                max="50"
                step="0.5"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="store-phone-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Phone (for receipts)
              </label>
              <input
                id="store-phone-input"
                type="text"
                maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+92 300 1234567"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="store-address-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Address (for receipts)
              </label>
              <input
                id="store-address-input"
                type="text"
                maxLength={BLUEPRINT_LIMITS.ADDRESS_MAX}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Main Boulevard, Shop 12"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              Brand Color Theme
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {THEME_PRESETS.map((preset) => {
                const selected = primaryColor === preset.primaryColor;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setPrimaryColor(preset.primaryColor);
                      setAccentColor(preset.accentColor);
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors cursor-pointer ${
                      selected
                        ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                        : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <span
                      className="w-6 h-6 rounded-md block"
                      style={{ backgroundColor: preset.primaryColor }}
                    />
                    <span className="text-[11px] text-slate-700 dark:text-slate-300 truncate max-w-full">
                      {preset.name.split(' ')[0]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={seedStarterCatalog}
              onChange={(e) => setSeedStarterCatalog(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-slate-900"
            />
            <span>
              Preload 8 sample {businessType === 'retail' ? 'retail items with barcodes' : 'restaurant menu dishes'} so I can test billing immediately
            </span>
          </label>

          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            {canClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60 cursor-pointer"
              style={{ backgroundColor: primaryColor }}
            >
              {submitting ? 'Creating Workspace...' : 'Launch POS Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
