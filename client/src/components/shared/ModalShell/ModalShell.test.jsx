import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ModalShell from './ModalShell';

afterEach(cleanup);

function renderShell(props = {}) {
  return render(
    <ModalShell
      eyebrow="LP Orchestrator"
      title="Editar configuración"
      desc="ETH / USDC · #42"
      onClose={props.onClose || (() => {})}
      footer={<button type="button">Guardar</button>}
      {...props}
    >
      <input aria-label="campo" />
    </ModalShell>,
  );
}

describe('ModalShell', () => {
  it('pinta cabecera, cuerpo y pie', () => {
    renderShell();
    expect(screen.getByText('LP Orchestrator')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Editar configuración' })).toBeTruthy();
    expect(screen.getByText('ETH / USDC · #42')).toBeTruthy();
    expect(screen.getByLabelText('campo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeTruthy();
  });

  it('expone el diálogo con nombre accesible tomado del título', () => {
    renderShell();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Editar configuración');
  });

  it('cierra con Escape', async () => {
    const onClose = vi.fn();
    renderShell({ onClose });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cierra al pulsar fuera pero no al pulsar dentro', async () => {
    const onClose = vi.fn();
    const { container } = renderShell({ onClose });

    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(container.querySelector('[data-testid="modal-overlay"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cierra con el botón de cerrar', async () => {
    const onClose = vi.fn();
    renderShell({ onClose });
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar diálogo' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('con closeDisabled ignora Escape, click fuera y botón de cerrar', async () => {
    const onClose = vi.fn();
    renderShell({ onClose, closeDisabled: true });

    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('modal-overlay'));
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar diálogo' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('bloquea el scroll del body mientras está abierto y lo restaura al cerrar', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = renderShell();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('atrapa el foco: Tab desde el último elemento vuelve al primero', async () => {
    renderShell();
    const closeBtn = screen.getByRole('button', { name: 'Cerrar diálogo' });
    const guardar = screen.getByRole('button', { name: 'Guardar' });

    guardar.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(closeBtn);
  });

  it('atrapa el foco hacia atrás: Shift+Tab desde el primero va al último', async () => {
    renderShell();
    const closeBtn = screen.getByRole('button', { name: 'Cerrar diálogo' });
    const guardar = screen.getByRole('button', { name: 'Guardar' });

    closeBtn.focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(guardar);
  });

  it('devuelve el foco al elemento que lo abrió', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = renderShell();
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('omite el pie cuando no se pasa footer', () => {
    renderShell({ footer: null });
    expect(screen.queryByRole('button', { name: 'Guardar' })).toBeNull();
  });

  it('en variant drawer sigue siendo un diálogo y respeta Escape', async () => {
    const onClose = vi.fn();
    renderShell({ onClose, variant: 'drawer' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
