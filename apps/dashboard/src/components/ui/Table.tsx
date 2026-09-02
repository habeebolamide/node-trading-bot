import { cn } from '@/lib/cn';
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

/** Compact data table. Rows are keyed by the caller; scroll shells go inside a Card body. */
export function Table({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full text-sm', className)} {...rest}>{children}</table>;
}
export function Thead({ children }: { children: React.ReactNode }) {
  return <thead className="border-b border-neutral-800 bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-400">{children}</thead>;
}
export function Th({ className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('px-3 py-2 font-medium', className)} {...rest}>{children}</th>;
}
export function Tbody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function Tr({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-neutral-900/50 hover:bg-neutral-900/40', className)} {...rest}>{children}</tr>;
}
export function Td({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2 align-top', className)} {...rest}>{children}</td>;
}
