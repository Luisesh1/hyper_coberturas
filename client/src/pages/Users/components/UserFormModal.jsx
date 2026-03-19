import { useState, useEffect } from 'react';
import styles from './UserFormModal.module.css';

const EMPTY = { username: '', password: '', name: '', role: 'user' };

export default function UserFormModal({ user, onSave, onClose }) {
  const isEdit = Boolean(user?.id);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isEdit) {
      setForm({ username: user.username, password: '', name: user.name, role: user.role });
    } else {
      setForm(EMPTY);
    }
  }, [user, isEdit]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('El nombre es obligatorio'); return; }
    if (!isEdit && !form.username.trim()) { setError('El usuario es obligatorio'); return; }
    if (!isEdit && !form.password) { setError('La contraseña es obligatoria'); return; }

    setSaving(true);
    try {
      await onSave(form, user);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.headerTitle}>{isEdit ? 'Editar usuario' : 'Nuevo usuario'}</span>
          <button type="button" className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.body}>
            <div className={styles.field}>
              <label className={styles.label}>Nombre completo</label>
              <input
                className={styles.input}
                name="name"
                value={form.name}
                onChange={handleChange}
                placeholder="Juan Perez"
                disabled={saving}
                autoFocus
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Usuario</label>
              <input
                className={styles.input}
                name="username"
                value={form.username}
                onChange={handleChange}
                placeholder="jperez"
                disabled={saving || isEdit}
                autoComplete="off"
              />
              {isEdit && <span className={styles.hint}>El nombre de usuario no se puede cambiar</span>}
            </div>

            <div className={styles.field}>
              <label className={styles.label}>{isEdit ? 'Nueva contraseña' : 'Contraseña'}</label>
              <input
                className={styles.input}
                name="password"
                type="password"
                value={form.password}
                onChange={handleChange}
                placeholder={isEdit ? 'Dejar vacio para no cambiar' : '••••••••'}
                disabled={saving}
                autoComplete="off"
              />
            </div>

            {!isEdit && (
              <div className={styles.field}>
                <label className={styles.label}>Rol</label>
                <select className={styles.input} name="role" value={form.role} onChange={handleChange} disabled={saving}>
                  <option value="user">Usuario</option>
                  <option value="superuser">Superusuario</option>
                </select>
              </div>
            )}

            {error && <p className={styles.error}>{error}</p>}
          </div>

          <div className={styles.footer}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
            <button type="submit" className={styles.saveBtn} disabled={saving}>
              {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
