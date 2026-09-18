// hooks/useAuth.js — thin alias over AuthContext for screens that only need the user.
import { useAuthContext } from '../context/AuthContext';

export function useAuth() {
  return useAuthContext();
}

export default useAuth;
