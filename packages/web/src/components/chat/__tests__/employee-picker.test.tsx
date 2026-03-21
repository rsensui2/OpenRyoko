import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatEmployeePicker } from '../chat-employee-picker'

// Mock EmployeeAvatar since it depends on settings context
vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name, size }: { name: string; size?: number }) => (
    <span data-testid={`avatar-${name}`} style={{ width: size, height: size }}>
      {name.charAt(0).toUpperCase()}
    </span>
  ),
}))

const mockEmployees = [
  { name: 'jimmy-dev', displayName: 'Jimmy Dev', department: 'platform', rank: 'senior' as const },
  { name: 'pravko-lead', displayName: 'Pravko Lead', department: 'pravko', rank: 'manager' as const },
  { name: 'homy-lead', displayName: 'Homy Lead', department: 'homy', rank: 'manager' as const },
  { name: 'sqlnoir-lead', displayName: 'SQLNoir Lead', department: 'sqlnoir', rank: 'manager' as const },
  { name: 'spycam-lead', displayName: 'SpyCam Lead', department: 'spycam', rank: 'manager' as const },
  { name: 'movekit-lead', displayName: 'MoveKit Lead', department: 'movekit', rank: 'senior' as const },
  { name: 'homy-writer', displayName: 'Homy Writer', department: 'homy', rank: 'employee' as const },
  { name: 'pravko-writer', displayName: 'Pravko Writer', department: 'pravko', rank: 'employee' as const },
  { name: 'reddit-scout', displayName: 'Reddit Scout', department: 'marketing', rank: 'employee' as const },
]

describe('ChatEmployeePicker', () => {
  let onChange: ReturnType<typeof vi.fn<(name: string | null) => void>>

  beforeEach(() => {
    onChange = vi.fn<(name: string | null) => void>()
  })

  it('renders COO as the default selected option', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    // COO chip should be visually selected
    const cooChip = screen.getByRole('button', { name: /jinn/i })
    expect(cooChip).toBeDefined()
    expect(cooChip.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows first 7 employees plus COO', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    // COO + 7 employees visible initially (before "More")
    // The 8th and 9th employees should be hidden behind "More"
    expect(screen.getByText('Jimmy Dev')).toBeDefined()
    expect(screen.getByText('Homy Writer')).toBeDefined()
    // 8th employee (index 7) should NOT be visible initially
    expect(screen.queryByText('Pravko Writer')).toBeNull()
  })

  it('shows "More" button when there are more than 7 employees', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    expect(screen.getByRole('button', { name: /more/i })).toBeDefined()
  })

  it('does not show "More" button when 7 or fewer employees', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees.slice(0, 7)}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull()
  })

  it('expands to show all employees when "More" is clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    // Now all employees should be visible
    expect(screen.getByText('Pravko Writer')).toBeDefined()
    expect(screen.getByText('Reddit Scout')).toBeDefined()
  })

  it('calls onSelect with employee name when clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    fireEvent.click(screen.getByText('Jimmy Dev'))
    expect(onChange).toHaveBeenCalledWith('jimmy-dev')
  })

  it('calls onSelect with null when COO is clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee="jimmy-dev"
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /jinn/i }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('shows selected state on the chosen employee', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee="jimmy-dev"
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    // COO should NOT be selected
    const cooChip = screen.getByRole('button', { name: /jinn/i })
    expect(cooChip.getAttribute('aria-pressed')).toBe('false')

    // Jimmy Dev should be selected — find the button that contains "Jimmy Dev"
    const jimmyButtons = screen.getAllByRole('button').filter(
      btn => btn.textContent?.includes('Jimmy Dev')
    )
    expect(jimmyButtons.length).toBeGreaterThan(0)
    expect(jimmyButtons[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('displays department for each employee', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees.slice(0, 3)}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    expect(screen.getByText('platform')).toBeDefined()
    expect(screen.getByText('pravko')).toBeDefined()
    expect(screen.getByText('homy')).toBeDefined()
  })

  it('renders avatars for employees', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees.slice(0, 3)}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    expect(screen.getByTestId('avatar-jimmy-dev')).toBeDefined()
    expect(screen.getByTestId('avatar-pravko-lead')).toBeDefined()
  })

  it('collapses expanded list when "Less" is clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Jinn"
      />
    )
    // Expand
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    expect(screen.getByText('Reddit Scout')).toBeDefined()

    // Collapse
    fireEvent.click(screen.getByRole('button', { name: /less/i }))
    expect(screen.queryByText('Reddit Scout')).toBeNull()
  })
})
