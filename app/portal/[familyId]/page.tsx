export default async function FamilyDashboard({ params }: { params: Promise<{ familyId: string }> }) {
  const { familyId } = await params;

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1>Hogue Family Dashboard</h1>
        <p style={{ color: '#666', marginTop: '0.5rem' }}>
          Family ID: {familyId}
        </p>
      </header>

      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', 
        gap: '1.5rem' 
      }}>
        {/* Active Todos */}
        <div style={{ 
          background: 'white', 
          padding: '1.5rem', 
          borderRadius: '8px', 
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)' 
        }}>
          <h2 style={{ marginBottom: '1rem', fontSize: '1.3rem' }}>Active Todos</h2>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            <li style={{ padding: '0.75rem', borderBottom: '1px solid #eee' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" />
                <span>Buy groceries for dinner</span>
              </div>
            </li>
            <li style={{ padding: '0.75rem', borderBottom: '1px solid #eee' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" />
                <span>Schedule dentist appointment</span>
              </div>
            </li>
            <li style={{ padding: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" />
                <span>Call insurance company</span>
              </div>
            </li>
          </ul>
          <button style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            width: '100%'
          }}>
            Add Todo
          </button>
        </div>

        {/* Family Members */}
        <div style={{ 
          background: 'white', 
          padding: '1.5rem', 
          borderRadius: '8px', 
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)' 
        }}>
          <h2 style={{ marginBottom: '1rem', fontSize: '1.3rem' }}>Family Members</h2>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            <li style={{ padding: '0.75rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Jon Hogue</span>
              <span style={{ fontSize: '0.85rem', color: '#0070f3', fontWeight: '500' }}>Owner</span>
            </li>
            <li style={{ padding: '0.75rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Carrie Hogue</span>
              <span style={{ fontSize: '0.85rem', color: '#666' }}>Member</span>
            </li>
            <li style={{ padding: '0.75rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Cara Hogue</span>
              <span style={{ fontSize: '0.85rem', color: '#666' }}>Member</span>
            </li>
            <li style={{ padding: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Robert Hogue</span>
              <span style={{ fontSize: '0.85rem', color: '#666' }}>Member</span>
            </li>
          </ul>
          <button style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            width: '100%'
          }}>
            Manage Roles
          </button>
        </div>
      </div>

      {/* Recent Activity */}
      <div style={{ 
        marginTop: '2rem',
        background: 'white', 
        padding: '1.5rem', 
        borderRadius: '8px', 
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)' 
      }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.3rem' }}>Recent Conversations</h2>
        <div style={{ color: '#666' }}>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>Today:</strong> 12 messages
          </p>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>This week:</strong> 89 messages
          </p>
          <p>
            <strong>Last active:</strong> 5 minutes ago
          </p>
        </div>
      </div>
    </div>
  )
}
