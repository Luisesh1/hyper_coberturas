/**
 * UsersPanel.jsx
 *
 * Panel de gestión de usuarios — solo accesible para superusers.
 * Permite: ver lista, crear usuario, cambiar rol, activar/desactivar.
 */

import { useState, useEffect, useCallback } from 'react';
import { usersApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import styles from './UsersPanel.module.css';

const ROLE_LABELS = { user: 'Usuario', superuser: 'Superusuario' };

function CreateUserForm({ onCreated }) {
  const [form,    setForm]    = useState({ username: '', password: '', name: '', role: 'user' });
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.username || !form.password || !form.name) {
      setError('Todos los campos son obligatorios');
      return;
    }
    setSaving(true);
    try {
      const user = await usersApi.create(form);
      onCreated(user);
      setForm({ username: '', password: '', name: '', role: 'user' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.createSection}>
      <h3 className={styles.sectionTitle}>Crear usuario</h3>
      <form className={styles.createForm} onSubmit={handleSubmit}>
        <div className={styles.formRow}>
          <div className={styles.field}>
            <label className={styles.label}>Nombre completo</label>
            <input className={styles.input} name="name" value={form.name} onChange={handleChange} placeholder="Juan Pérez" disabled={saving} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Usuario</label>
            <input className={styles.input} name="username" value={form.username} onChange={handleChange} placeholder="jperez" disabled={saving} autoComplete="off" />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Contraseña</label>
            <input className={styles.input} name="password" type="password" value={form.password} onChange={handleChange} placeholder="••••••••" disabled={saving} autoComplete="off" />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Rol</label>
            <select className={styles.input} name="role" value={form.role} onChange={handleChange} disabled={saving}>
              <option value="user">Usuario</option>
              <option value="superuser">Superusuario</option>
            </select>
          </div>
          <button type="submit" className={styles.createBtn} disabled={saving}>
            {saving ? 'Creando…' : '+ Crear'}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </section>
  );
}

function UserRow({ user, currentUserId, onUpdate }) {
  const [busy, setBusy] = useState(false);

  const isSelf = user.id === currentUserId;

  async function toggle(fn, ...args) {
    setBusy(true);
    try {
      const updated = await fn(...args);
      onUpdate(updated);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={`${styles.row} ${!user.active ? styles.rowInactive : ''}`}>
      <td className={styles.cell}>
        <span className={styles.name}>{user.name}</span>
        <span className={styles.username}>@{user.username}</span>
        {isSelf && <span className={styles.selfBadge}>yo</span>}
      </td>
      <td className={styles.cell}>
        <span className={user.role === 'superuser' ? styles.roleSu : styles.roleUser}>
          {ROLE_LABELS[user.role]}
        </span>
      </td>
      <td className={styles.cell}>
        <span className={user.active ? styles.statusOn : styles.statusOff}>
          {user.active ? 'Activo' : 'Inactivo'}
        </span>
      </td>
      <td className={styles.cell}>
        <span className={styles.date}>{new Date(user.createdAt).toLocaleDateString()}</span>
      </td>
      <td className={`${styles.cell} ${styles.actions}`}>
        {!isSelf && (
          <>
            <button
              className={styles.actionBtn}
              onClick={() => toggle(
                usersApi.setRole,
                user.id,
                user.role === 'superuser' ? 'user' : 'superuser'
              )}
              disabled={busy}
              title={user.role === 'superuser' ? 'Quitar superusuario' : 'Hacer superusuario'}
            >
              {user.role === 'superuser' ? '↓ User' : '↑ SU'}
            </button>
            <button
              className={`${styles.actionBtn} ${user.active ? styles.deactivateBtn : styles.activateBtn}`}
              onClick={() => toggle(usersApi.setActive, user.id, !user.active)}
              disabled={busy}
            >
              {user.active ? 'Desactivar' : 'Activar'}
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

export default function UsersPanel() {
  const { user: currentUser } = useAuth();
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(() => {
    setLoading(true);
    usersApi.getAll()
      .then(setUsers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (user) => setUsers((prev) => [...prev, user]);
  const handleUpdated = (updated) => setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Gestión de Usuarios</h2>
          <p className={styles.subtitle}>{users.length} usuario{users.length !== 1 ? 's' : ''} registrados</p>
        </div>
        <button className={styles.refreshBtn} onClick={load} title="Recargar">↻</button>
      </div>

      <CreateUserForm onCreated={handleCreated} />

      <section className={styles.tableSection}>
        <h3 className={styles.sectionTitle}>Usuarios del sistema</h3>
        {loading && <p className={styles.empty}>Cargando…</p>}
        {!loading && error && <p className={styles.errorMsg}>{error}</p>}
        {!loading && !error && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Usuario</th>
                  <th className={styles.th}>Rol</th>
                  <th className={styles.th}>Estado</th>
                  <th className={styles.th}>Creado</th>
                  <th className={styles.th}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    currentUserId={currentUser?.userId}
                    onUpdate={handleUpdated}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
