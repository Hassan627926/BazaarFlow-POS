import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

interface BarcodeSvgProps {
  value: string;
  height?: number;
  width?: number;
  fontSize?: number;
  displayValue?: boolean;
  className?: string;
}

export const BarcodeSvg: React.FC<BarcodeSvgProps> = ({
  value,
  height = 44,
  width = 1.6,
  fontSize = 12,
  displayValue = true,
  className = '',
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || !value.trim()) return;

    const cleanVal = value.trim();
    const isEan13 = /^\d{13}$/.test(cleanVal);

    try {
      JsBarcode(el, cleanVal, {
        format: isEan13 ? 'EAN13' : 'CODE128',
        lineColor: '#0F172A',
        background: '#FFFFFF',
        width,
        height,
        displayValue,
        fontSize,
        font: 'JetBrains Mono, monospace',
        margin: 4,
      });
    } catch {
      try {
        JsBarcode(el, cleanVal, {
          format: 'CODE128',
          lineColor: '#0F172A',
          background: '#FFFFFF',
          width,
          height,
          displayValue,
          fontSize,
          font: 'JetBrains Mono, monospace',
          margin: 4,
        });
      } catch {
        // Invalid characters ignored safely
      }
    }
  }, [value, height, width, fontSize, displayValue]);

  if (!value.trim()) {
    return (
      <div className="text-xs text-slate-400 font-mono py-2">
        No barcode assigned
      </div>
    );
  }

  return (
    <svg
      ref={svgRef}
      className={`max-w-full h-auto bg-white rounded ${className}`}
      aria-label={`Barcode ${value}`}
    />
  );
};
