import { useState } from 'react';

export function useFeedback() {
  const [feedback, setFeedback] = useState(null);
  const show = (type, text) => {
    setFeedback({ type, text });
    setTimeout(() => setFeedback(null), 4000);
  };
  return [feedback, show];
}
