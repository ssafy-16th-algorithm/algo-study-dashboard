export const REVIEW_VERSION=16;
export const SCORE_RUBRIC_VERSION=1;

export const SCORE_RUBRIC = [
  {id:'correctness',label:'정답성',max:40,description:'문제 요구사항, 로직, 경계값 처리',bands:'36~40: 구체적인 오류를 찾지 못함 · 24~35: 일부 조건·경계값 위험 · 0~23: 오답을 만드는 구체적인 실행 흐름이나 반례가 있음'},
  {id:'efficiency',label:'시간·공간 효율',max:30,description:'시간·공간 복잡도, 불필요한 연산과 저장',bands:'27~30: 입력 규모에 적합하고 낭비가 적음 · 18~26: 줄일 수 있는 반복·메모리 사용 · 0~17: 시간·메모리 초과의 구체적인 위험'},
  {id:'stability',label:'구현 안정성',max:20,description:'인덱스, 자료형, 초기화, 상태 복구',bands:'18~20: 자료형·상태·경계 처리가 안정적 · 12~17: 일부 구현 위험 · 0~11: 예외·오버플로·상태 오염의 구체적인 위험'},
  {id:'readability',label:'가독성',max:10,description:'의미 있는 이름, 구조, 중복 제거',bands:'9~10: 의도와 흐름이 명확 · 6~8: 이름·중복·구조에 개선 여지 · 0~5: 실행 흐름을 이해하기 어려움'},
] as const;

export type ScoreCriterionId = typeof SCORE_RUBRIC[number]['id'];
export type ScoreGrade = 'S'|'A'|'B'|'C'|'D';
export type ReviewScore = {
  rubricVersion:number;
  total:number;
  grade:ScoreGrade;
  criteria:Record<ScoreCriterionId,{points:number;reason:string}>;
};

export const SCORE_GRADES = [
  {grade:'S',min:90},{grade:'A',min:80},{grade:'B',min:70},{grade:'C',min:60},{grade:'D',min:0},
] as const;

export function normalizeReviewScore(value:unknown):ReviewScore|null {
  if (!value || typeof value!=='object') return null;
  const raw=(value as {criteria?:unknown}).criteria;
  if (!raw || typeof raw!=='object') return null;
  const criteria={} as ReviewScore['criteria'];
  let total=0;
  for (const rule of SCORE_RUBRIC) {
    const item=(raw as Record<string,unknown>)[rule.id];
    if (!item || typeof item!=='object') return null;
    const {points,reason}=item as {points?:unknown;reason?:unknown};
    if (typeof points!=='number' || !Number.isInteger(points) || points<0 || points>rule.max || typeof reason!=='string' || !reason.trim()) return null;
    criteria[rule.id]={points,reason:reason.trim().slice(0,280)};
    total+=points;
  }
  const grade=SCORE_GRADES.find((tier)=>total>=tier.min)!.grade;
  return {rubricVersion:SCORE_RUBRIC_VERSION,total,grade,criteria};
}

export function nextScoreGoal(total:number):{label:string;remaining:number}|null {
  if (total>=100) return null;
  const next=[...SCORE_GRADES].reverse().find((tier)=>tier.min>total);
  return next?{label:`${next.grade}등급`,remaining:next.min-total}:{label:'100점',remaining:100-total};
}
