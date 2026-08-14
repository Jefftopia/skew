import { useState, version } from 'react';

/**
 * A stock React app. No Braid import, no adapter, no awareness of being embedded — it is
 * composed into an Angular host by the compat adapter, which is the default.
 *
 * React 19 lives entirely inside this fragment's realm, so the Angular host's own framework and
 * this one cannot collide.
 */
interface Review {
  id: number;
  author: string;
  stars: number;
  body: string;
}

const SEED: Review[] = [
  { id: 1, author: 'Dana', stars: 5, body: 'Invoicing finally makes sense.' },
  { id: 2, author: 'Ravi', stars: 4, body: 'Fast, though I miss bulk export.' },
];

export function App() {
  const [reviews, setReviews] = useState(SEED);
  const [draft, setDraft] = useState('');

  const add = () => {
    if (!draft.trim()) return;
    setReviews((current) => [
      ...current,
      { id: current.length + 1, author: 'You', stars: 5, body: draft.trim() },
    ]);
    setDraft('');
  };

  return (
    <section className="react-remote">
      <header>
        <span className="badge">React {version}</span>
        <strong>Customer reviews</strong>
      </header>

      <ul>
        {reviews.map((review) => (
          <li key={review.id}>
            <span className="stars" aria-label={`${review.stars} of 5`}>
              {'★'.repeat(review.stars)}
              <span className="dim">{'★'.repeat(5 - review.stars)}</span>
            </span>
            <span className="author">{review.author}</span>
            <span className="body">{review.body}</span>
          </li>
        ))}
      </ul>

      <div className="composer">
        <input
          value={draft}
          placeholder="Add a review — proves React state is live in here"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <button type="button" onClick={add}>
          Post
        </button>
      </div>
    </section>
  );
}
