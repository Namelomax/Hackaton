"use client";

import { AnimatePresence, motion } from "framer-motion";
import * as React from "react";

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => onOpenChange(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ duration: 0.25 }}
            className="bg-white text-black rounded-2xl shadow-lg p-6 w-full max-w-md mx-2"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const AlertDialogContent = ({ children }: { children: React.ReactNode }) => (
  <div>{children}</div>
);

export const AlertDialogHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-4 border-b border-neutral-200 pb-2">{children}</div>
);

export const AlertDialogTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="text-lg font-semibold text-black">{children}</h2>
);

export const AlertDialogDescription = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-neutral-600 mt-1">{children}</p>
);

export const AlertDialogFooter = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-4 flex justify-end gap-2">{children}</div>
);

export const AlertDialogCancel = ({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    {...props}
    className="px-3 py-1.5 rounded-md bg-neutral-100 hover:bg-neutral-200 transition"
  >
    {children}
  </button>
);

export const AlertDialogAction = ({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    {...props}
    className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 transition"
  >
    {children}
  </button>
);
