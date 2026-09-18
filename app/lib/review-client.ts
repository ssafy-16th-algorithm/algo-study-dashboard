import type { Review, ReviewRequest } from './review';
import { isRetryableStatus, retryAfterSeconds } from './review-retry';
import { normalizeReviewScore } from './review-score';

export type ReviewRetryState = {attempt:number;retryAt:number};
export class ReviewRequestError extends Error {
  retryAt:number;
  retryable:boolean;
  constructor(message:string,retryable=false,retryAt=0) {
    super(message);
    this.name='ReviewRequestError';
    this.retryable=retryable;
    this.retryAt=retryAt;
  }
}

function waitForRetry(delay:number,signal?:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{
    signal?.throwIfAborted();
    const onAbort=()=>{clearTimeout(timer);reject(signal?.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},delay);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function fetchReview(input:ReviewRequest,signal?:AbortSignal):Promise<Review> {
  signal?.throwIfAborted();
  const timeoutController=new AbortController();
  const timeout=setTimeout(()=>timeoutController.abort(new DOMException('Review request timed out','TimeoutError')),60_000);
  try {
    const response=await fetch('/api/review',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),
      signal:signal?AbortSignal.any([signal,timeoutController.signal]):timeoutController.signal,
    });
    let body:{review?:Review;error?:string;retryable?:boolean;retryAfterSeconds?:number}={};
    const text=await response.text();
    try {
      const parsed:unknown=JSON.parse(text);
      if (parsed && typeof parsed==='object') body=parsed;
    } catch { /* Gateway errors can contain HTML instead of JSON. */ }
    const score=normalizeReviewScore(body.review?.score);
    if (response.ok && body.review && score && typeof body.review.verdict==='string' && typeof body.review.currentApproach==='string' && Array.isArray(body.review.issues)) return {...body.review,score};
    const delay=Math.max(
      retryAfterSeconds(response.headers.get('Retry-After')) ?? 0,
      typeof body.retryAfterSeconds==='number'&&Number.isFinite(body.retryAfterSeconds)?Math.max(0,body.retryAfterSeconds):0,
    );
    throw new ReviewRequestError(
      typeof body.error==='string'?body.error:'AI 리뷰 응답을 받지 못했습니다.',
      body.retryable!==false && (response.ok || isRetryableStatus(response.status)),
      delay?Date.now()+delay*1000:0,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ReviewRequestError) throw error;
    throw new ReviewRequestError(timeoutController.signal.aborted?'AI 리뷰 응답 시간이 초과되었습니다.':'AI 리뷰 서버에 연결하지 못했습니다.',true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestReviewWithRetry(input:ReviewRequest,options:{signal?:AbortSignal;onRetry?:(state:ReviewRetryState|null)=>void}={}):Promise<Review> {
  for (let attempt=1;attempt<=3;attempt++) {
    options.signal?.throwIfAborted();
    options.onRetry?.(null);
    try {
      return await fetchReview(input,options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof ReviewRequestError) || !error.retryable) throw error;
      if (attempt===3) throw new ReviewRequestError(`${error.message} 자동 재시도 2회를 마쳤습니다. 잠시 후 다시 요청해 주세요.`,false,error.retryAt);
      const delay=Math.max(2000*2**(attempt-1)+Math.floor(Math.random()*250),error.retryAt-Date.now());
      if (delay>30_000) throw new ReviewRequestError(`${error.message} 대기시간이 길어 자동 재시도를 멈췄습니다.`,false,error.retryAt);
      options.onRetry?.({attempt:attempt+1,retryAt:Date.now()+delay});
      await waitForRetry(delay,options.signal);
    }
  }
  throw new Error('리뷰 요청을 완료하지 못했습니다.');
}
