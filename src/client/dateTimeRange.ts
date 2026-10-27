export interface DateTimeRange { start?: number; end?: number }
export const dateText = (date: Date): string => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export const timeText = (date: Date): string => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
export function parseLocalDateTime(day: string, time: string): number | undefined {
  if (!day) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!match || !clock) throw new Error('请输入有效的日期和时间')
  const [year, month, date] = match.slice(1).map(Number)
  const [hour, minute, second = 0] = clock.slice(1).map((part) => part === undefined ? 0 : Number(part))
  const value = new Date(0)
  value.setFullYear(year, month - 1, date); value.setHours(hour, minute, second, 0)
  if (year < 1970 || year > 9999 || value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== date ||
    hour > 23 || minute > 59 || second > 59 || value.getHours() !== hour || value.getMinutes() !== minute || value.getSeconds() !== second) throw new Error('请输入有效的日期和时间')
  return value.getTime()
}
export function calendarDays(month: Date): Date[] {
  const start = new Date(month.getFullYear(), month.getMonth(), 1)
  start.setDate(start.getDate() - start.getDay())
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index))
}
export function rangeFromFields(startDate: string, startTime: string, endDate: string, endTime: string): DateTimeRange {
  const start = parseLocalDateTime(startDate, startTime)
  const endSecond = parseLocalDateTime(endDate, endTime)
  // The picker displays seconds; include the whole final second in a millisecond query.
  const end = endSecond === undefined ? undefined : endSecond + 999
  if (start !== undefined && end !== undefined && start > end) throw new Error('开始时间不能晚于结束时间')
  return { start, end }
}
