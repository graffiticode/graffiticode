// SPDX-License-Identifier: MIT
import React from "react";

interface ProtectedCellTooltipProps {
  visible: boolean;
  x: number;
  y: number;
  message?: string;
}

export const ProtectedCellTooltip: React.FC<ProtectedCellTooltipProps> = ({
  visible,
  x,
  y,
  message = "This cell is protected and cannot be edited"
}) => {
  if (!visible) return null;

  return (
    <div
      className="fixed z-50 bg-gray-600 text-white text-xs px-2 py-1 rounded shadow-lg pointer-events-none"
      style={{
        left: x,
        top: y - 30, // Position above the cursor
        transform: 'translateX(-50%)', // Center horizontally
      }}
    >
      <div className="relative">
        {message}
        {/* Arrow pointing down */}
        <div
          className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0"
          style={{
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: '4px solid #4b5563',
          }}
        />
      </div>
    </div>
  );
};