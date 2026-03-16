import { useCallback, useState } from 'react';

export function useConfirmAction() {
  const [dialog, setDialog] = useState({ open: false });

  const confirm = useCallback(({ title, message, confirmLabel = 'Confirmar', variant = 'danger' }) => {
    return new Promise((resolve) => {
      setDialog({
        open: true,
        title,
        message,
        confirmLabel,
        variant,
        onConfirm: () => { setDialog({ open: false }); resolve(true); },
        onCancel: () => { setDialog({ open: false }); resolve(false); },
      });
    });
  }, []);

  return { dialog, confirm };
}
