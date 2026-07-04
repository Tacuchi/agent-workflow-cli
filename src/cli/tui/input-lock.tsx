import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";

interface InputLockValue {
  locked: boolean;
  lock: () => void;
  unlock: () => void;
}

const InputLockContext = createContext<InputLockValue>({
  locked: false,
  lock: () => {},
  unlock: () => {},
});

export function InputLockProvider({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(false);
  const lock = useCallback(() => setLocked(true), []);
  const unlock = useCallback(() => setLocked(false), []);
  return (
    <InputLockContext.Provider value={{ locked, lock, unlock }}>
      {children}
    </InputLockContext.Provider>
  );
}

export function useInputLock(): InputLockValue {
  return useContext(InputLockContext);
}

/** Hold the global input lock while `locked` is true; always released on unmount. */
export function useLockWhile(locked: boolean): void {
  const { lock, unlock } = useInputLock();
  useEffect(() => {
    if (locked) lock();
    else unlock();
    return unlock;
  }, [locked, lock, unlock]);
}
