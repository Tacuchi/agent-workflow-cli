import { type ReactNode, createContext, useCallback, useContext, useState } from "react";

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
