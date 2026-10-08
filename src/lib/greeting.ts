/** Time-of-day greeting for the new-chat screen, in the style of the big
 * chat apps. Pure function of the hour so it's testable and stable. */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return '早上好';
  if (hour >= 12 && hour < 18) return '下午好';
  if (hour >= 18 && hour < 23) return '晚上好';
  return '夜深了';
}
